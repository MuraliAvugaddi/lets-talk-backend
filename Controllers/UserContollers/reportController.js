const Attendance = require("../../Models/attendance");
const User = require("../../Models/users");
const Practice = require("../../Models/practice");
const Result = require("../../Models/result");
const { istParts, dateKey, normalizeDateKey } = require("../../utils/time");
const { normStage, isValidId, ADMIN_ROLES } = require("../../utils/normalize");
const { loadHolidays, holidayApplies } = require("../../utils/holidays");
const rules = require("../../utils/attendanceRules");

// =====================================================
// ATTENDANCE REPORT (monthly calendar + yearly graph)
// GET /api/attendance-report?userId=&year=2026&month=10&range=month|3m|6m|year
//   range 3m / 6m = the last 3 / 6 months ending at year+month (can cross into last year)
//   + practice: trainer's speaking-practice ratings (day + stage wise) in that period
//   + tests:    test results in that period (with the date the admin published the test)
//
// • admin / manager can see anyone (trainer salary, student progress)
// • everyone else sees only their own report
//
// A day with no record (after the person joined, not in the future)
// counts as Absent — except weekly off days (WEEKLY_OFF, default Sunday).
// =====================================================

// 0 = Sunday … 6 = Saturday. "0" = Sunday off, "" = no weekly off, "0,6" = weekend off
const WEEKLY_OFF = String(process.env.WEEKLY_OFF ?? "0")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "")
  .map(Number)
  .filter((n) => n >= 0 && n <= 6);

// After this IST time today's missing record becomes "Absent" (auto-absent runs 20:15)
const DAY_CLOSE_MINUTES = 20 * 60 + 15;

const RANK = { Present: 3, Late: 2, Partial: 1, Absent: 0 };
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad = (n) => String(n).padStart(2, "0");
const keyOf = (y, m, d) => `${pad(d)}-${pad(m)}-${y}`;
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const weekdayOf = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const ymd = (y, m, d) => y * 10000 + m * 100 + d; // sortable number

const timeLabel = (date) => {
  if (!date) return null;
  const { hour, minute } = istParts(date);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${pad(minute)} ${hour < 12 ? "AM" : "PM"}`;
};

// One day can have several records (two stages, English + Hindi, trainer morning + afternoon) → combine
const combineDay = (records, isTrainer = false) => {
  let best = null;
  let minutes = 0;
  const details = [];
  const shifts = new Map(); // trainers: shift → best status
  let lateMinutes = 0;
  for (const r of records) {
    const status = r.status || "Absent";
    if (!best || (RANK[status] ?? 0) > (RANK[best] ?? 0)) best = status;
    minutes += r.totalMinutesSpent || 0;
    const came = ["Present", "Late", "Partial"].includes(status);
    if (isTrainer && came) {
      const key = rules.shiftOfRecord(r);
      const prev = shifts.get(key);
      const st = r.arrivalStatus === "Late" || status === "Late" ? "Late" : "Present";
      if (!prev || (prev === "Late" && st === "Present")) shifts.set(key, st);
    }
    if (came) lateMinutes += r.lateByMinutes || 0;
    details.push({
      shift: isTrainer ? rules.shiftOfRecord(r) : "",
      lateByMinutes: r.lateByMinutes || 0,
      stage: normStage(r.stage) || r.stage,
      language: r.language,
      status,
      minutes: r.totalMinutesSpent || 0,
      batchTime: r.batchTime && r.batchTime !== "N/A" ? r.batchTime : null,
      mode: r.userMode,
      checkIn: timeLabel(r.markedAt || r.firstJoinAt || r.joinTime),
    });
  }
  const shiftsAttended = shifts.size;
  const lateShifts = [...shifts.values()].filter((v) => v === "Late").length;
  return { status: best || "Absent", minutes, details, shiftsAttended, lateShifts, lateMinutes };
};

const emptyTotals = () => ({
  present: 0,
  late: 0,
  partial: 0,
  absent: 0,
  holiday: 0,
  workingDays: 0,
  minutes: 0,
  // trainers (salary): two attendances a day
  shiftsAttended: 0,
  lateShifts: 0,
  lateMinutes: 0,
});

const addToTotals = (t, status, minutes, day = null) => {
  if (status === "Holiday") {
    t.holiday += 1;
    return;
  }
  if (!["Present", "Late", "Partial", "Absent"].includes(status)) return; // Upcoming / NotJoined
  t.workingDays += 1;
  t.minutes += minutes || 0;
  t[status.toLowerCase()] += 1;
  if (day) {
    t.shiftsAttended += day.shiftsAttended || 0;
    t.lateShifts += day.lateShifts || 0;
    t.lateMinutes += day.lateMinutes || 0;
  }
};

const finishTotals = (t) => {
  const attended = t.present + t.late + t.partial;
  return {
    ...t,
    attended, // days the person came at all (useful for salary)
    hours: Math.round((t.minutes / 60) * 10) / 10,
    percentage: t.workingDays ? Math.round((attended / t.workingDays) * 100) : 0,
  };
};

// Practice rows → totals, average stars, stage-wise breakdown (pure, tested)
const summarizePractice = (rows) => {
  const rated = rows.filter((r) => r.rating > 0);
  const avg = rated.length ? Math.round((rated.reduce((a, r) => a + r.rating, 0) / rated.length) * 10) / 10 : 0;
  const stages = new Map();
  for (const r of rows) {
    const key = `${r.language}|${r.stage}`;
    const s = stages.get(key) || { language: r.language, stage: r.stage, count: 0, rated: 0, sum: 0 };
    s.count += 1;
    if (r.rating > 0) {
      s.rated += 1;
      s.sum += r.rating;
    }
    stages.set(key, s);
  }
  const byStage = [...stages.values()]
    .map((s) => ({
      language: s.language,
      stage: s.stage,
      count: s.count,
      rated: s.rated,
      averageRating: s.rated ? Math.round((s.sum / s.rated) * 10) / 10 : 0,
    }))
    .sort((a, b) => (a.language === b.language ? a.stage.localeCompare(b.stage) : a.language.localeCompare(b.language)));
  return { count: rows.length, rated: rated.length, averageRating: avg, byStage, days: rows };
};

const getAttendanceReport = async (req, res) => {
  try {
    const isAdmin = ADMIN_ROLES.includes(req.user.role);
    const userId = isAdmin && req.query.userId ? String(req.query.userId) : String(req.user._id);
    if (!isValidId(userId)) return res.status(400).json({ message: "Valid userId required" });

    const now = istParts(new Date());
    const year = Number(req.query.year) || now.year;
    const month = Math.min(Math.max(Number(req.query.month) || now.month, 1), 12);
    if (year < 2020 || year > now.year + 1) return res.status(400).json({ message: "Invalid year" });

    const user = await User.findById(userId).select("name phone role mode language teacherStage createdAt").lean();
    if (!user) return res.status(404).json({ message: "User not found" });

    // All records of this person (≈ 1-2 per day, indexed on userId) → bucket by day of the requested year
    const [records, holidays] = await Promise.all([Attendance.find({ userId }).lean(), loadHolidays()]);
    const isTrainer = user.role !== "student";
    const holidayOf = (key) => {
      const h = holidays.get(key);
      return holidayApplies(h, user.role) ? h : null;
    };
    const byDay = new Map();
    for (const r of records) {
      const key = normalizeDateKey(r.date);
      if (!key) continue;
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(r);
    }

    const joined = istParts(user.createdAt || new Date(0));
    const joinedNum = ymd(joined.year, joined.month, joined.day);
    const todayNum = ymd(now.year, now.month, now.day);
    const todayClosed = now.hour * 60 + now.minute >= DAY_CLOSE_MINUTES;

    const statusOfDay = (y, m, d) => {
      const key = keyOf(y, m, d);
      const num = ymd(y, m, d);
      const recs = byDay.get(key);

      const hol = holidayOf(key);
      if (recs && recs.length) {
        const day = combineDay(recs, isTrainer);
        // 🏖 holiday + only auto-"Absent" rows (nobody came) → Holiday, not Absent
        if (hol && day.status === "Absent") return { key, status: "Holiday", holiday: hol.title, minutes: 0, details: [] };
        return { key, ...day, holiday: hol ? hol.title : null };
      }
      if (num < joinedNum) return { key, status: "NotJoined", minutes: 0, details: [] };
      if (num > todayNum || (num === todayNum && !todayClosed)) {
        return { key, status: "Upcoming", minutes: 0, details: [] };
      }
      if (hol) return { key, status: "Holiday", holiday: hol.title, minutes: 0, details: [] };
      if (WEEKLY_OFF.includes(weekdayOf(y, m, d))) return { key, status: "Holiday", holiday: "Weekly off", minutes: 0, details: [] };
      return { key, status: "Absent", minutes: 0, details: [] };
    };

    // ---- Month: one entry per day (calendar) ----
    const days = [];
    const monthTotals = emptyTotals();
    for (let d = 1; d <= daysInMonth(year, month); d++) {
      const s = statusOfDay(year, month, d);
      addToTotals(monthTotals, s.status, s.minutes, s);
      days.push({
        holiday: s.holiday || null,
        shiftsAttended: s.shiftsAttended || 0,
        lateMinutes: s.lateMinutes || 0,
        date: s.key,
        day: d,
        weekday: WEEKDAYS[weekdayOf(year, month, d)],
        weekdayIndex: weekdayOf(year, month, d),
        status: s.status,
        minutes: s.minutes,
        details: s.details,
      });
    }

    // ---- Year: totals per month (graph) ----
    const yearSummary = [];
    const yearTotals = emptyTotals();
    for (let m = 1; m <= 12; m++) {
      const t = emptyTotals();
      for (let d = 1; d <= daysInMonth(year, m); d++) {
        const s = statusOfDay(year, m, d);
        addToTotals(t, s.status, s.minutes, s);
        addToTotals(yearTotals, s.status, s.minutes, s);
      }
      yearSummary.push({ month: m, label: MONTH_NAMES[m - 1], ...finishTotals(t) });
    }

    // ---- Range: last 3 / 6 months (or the month / the year) ----
    const range = ["3m", "6m", "year"].includes(String(req.query.range)) ? String(req.query.range) : "month";
    const rangeList = []; // [{ y, m }]
    if (range === "year") {
      for (let m = 1; m <= 12; m++) rangeList.push({ y: year, m });
    } else {
      const count = range === "3m" ? 3 : range === "6m" ? 6 : 1;
      for (let i = count - 1; i >= 0; i--) {
        const total = year * 12 + (month - 1) - i;
        rangeList.push({ y: Math.floor(total / 12), m: (total % 12) + 1 });
      }
    }
    const rangeMonths = [];
    const rangeTotals = emptyTotals();
    for (const { y, m } of rangeList) {
      const t = emptyTotals();
      for (let d = 1; d <= daysInMonth(y, m); d++) {
        const st = statusOfDay(y, m, d);
        addToTotals(t, st.status, st.minutes, st);
        addToTotals(rangeTotals, st.status, st.minutes, st);
      }
      rangeMonths.push({ year: y, month: m, label: MONTH_NAMES[m - 1], ...finishTotals(t) });
    }
    const first = rangeList[0];
    const last = rangeList[rangeList.length - 1];
    const fromNum = ymd(first.y, first.m, 1);
    const toNum = ymd(last.y, last.m, 31);
    const inRange = (key) => {
      const k = normalizeDateKey(key);
      if (!k) return false;
      const [dd, mm, yy] = k.split("-").map(Number);
      const n = ymd(yy, mm, dd);
      return n >= fromNum && n <= toNum;
    };
    const rangeLabel =
      rangeList.length === 1
        ? `${MONTH_NAMES[first.m - 1]} ${first.y}`
        : `${MONTH_NAMES[first.m - 1]}${first.y !== last.y ? ` ${first.y}` : ""} – ${MONTH_NAMES[last.m - 1]} ${last.y}`;

    // ---- 🎤 Speaking practice ratings from trainers ----
    const practiceRows = (await Practice.find({ userId }).lean())
      .filter((p) => inRange(p.date))
      .map((p) => ({
        date: normalizeDateKey(p.date) || p.date,
        language: p.language,
        stage: normStage(p.stage) || p.stage,
        rating: p.rating || 0,
        tags: p.tags || [],
        note: p.note || "",
        trainerName: p.trainerName || "",
        practicedAt: p.practicedAt || p.createdAt,
      }))
      .sort((a, b) => new Date(b.practicedAt) - new Date(a.practicedAt));
    const practice = summarizePractice(practiceRows);

    // ---- 📝 Test results (+ when the admin published that test) ----
    const fromDate = new Date(Date.UTC(first.y, first.m - 1, 1) - 330 * 60000); // IST month start
    const toDate = new Date(Date.UTC(last.y, last.m, 1) - 330 * 60000);
    const resultRows = await Result.find({ userId, completedAt: { $gte: fromDate, $lt: toDate } })
      .sort({ completedAt: -1 })
      .lean();
    const tests = resultRows.map((r) => ({
      language: r.language,
      stage: normStage(r.stage) || r.stage,
      score: r.score,
      total: r.totalQuestions,
      percentage: r.totalQuestions ? Math.round((r.score / r.totalQuestions) * 100) : 0,
      completedAt: r.completedAt,
      testPublishedAt: r.testVersion ? new Date(r.testVersion) : null,
    }));
    const testAvg = tests.length ? Math.round(tests.reduce((a, t) => a + t.percentage, 0) / tests.length) : 0;

    res.status(200).json({
      range,
      rangeLabel,
      rangeMonths,
      rangeTotals: finishTotals(rangeTotals),
      practice,
      tests: { count: tests.length, averagePercentage: testAvg, results: tests },
      user: {
        _id: user._id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        mode: user.mode,
        joinedOn: dateKey(user.createdAt || new Date()),
      },
      year,
      month,
      monthLabel: `${MONTH_NAMES[month - 1]} ${year}`,
      weeklyOff: WEEKLY_OFF.map((n) => WEEKDAYS[n]),
      days,
      monthSummary: finishTotals(monthTotals),
      yearSummary,
      yearTotals: finishTotals(yearTotals),
    });
  } catch (error) {
    console.error("Attendance Report Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { getAttendanceReport, _internal: { combineDay, finishTotals, summarizePractice } };
