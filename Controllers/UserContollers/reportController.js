const Attendance = require("../../Models/attendance");
const User = require("../../Models/users");
const { istParts, dateKey, normalizeDateKey } = require("../../utils/time");
const { normStage, isValidId, ADMIN_ROLES } = require("../../utils/normalize");

// =====================================================
// ATTENDANCE REPORT (monthly calendar + yearly graph)
// GET /api/attendance-report?userId=&year=2026&month=10
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

// One day can have several records (two stages, English + Hindi) → combine
const combineDay = (records) => {
  let best = null;
  let minutes = 0;
  const details = [];
  for (const r of records) {
    const status = r.status || "Absent";
    if (!best || (RANK[status] ?? 0) > (RANK[best] ?? 0)) best = status;
    minutes += r.totalMinutesSpent || 0;
    details.push({
      stage: normStage(r.stage) || r.stage,
      language: r.language,
      status,
      minutes: r.totalMinutesSpent || 0,
      batchTime: r.batchTime && r.batchTime !== "N/A" ? r.batchTime : null,
      mode: r.userMode,
      checkIn: timeLabel(r.markedAt || r.firstJoinAt || r.joinTime),
    });
  }
  return { status: best || "Absent", minutes, details };
};

const emptyTotals = () => ({ present: 0, late: 0, partial: 0, absent: 0, holiday: 0, workingDays: 0, minutes: 0 });

const addToTotals = (t, status, minutes) => {
  if (status === "Holiday") {
    t.holiday += 1;
    return;
  }
  if (!["Present", "Late", "Partial", "Absent"].includes(status)) return; // Upcoming / NotJoined
  t.workingDays += 1;
  t.minutes += minutes || 0;
  t[status.toLowerCase()] += 1;
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
    const records = await Attendance.find({ userId }).lean();
    const byDay = new Map();
    for (const r of records) {
      const key = normalizeDateKey(r.date);
      if (!key) continue;
      const [, , yyyy] = key.split("-").map(Number);
      if (yyyy !== year) continue;
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

      if (recs && recs.length) return { key, ...combineDay(recs) };
      if (num < joinedNum) return { key, status: "NotJoined", minutes: 0, details: [] };
      if (num > todayNum || (num === todayNum && !todayClosed)) {
        return { key, status: "Upcoming", minutes: 0, details: [] };
      }
      if (WEEKLY_OFF.includes(weekdayOf(y, m, d))) return { key, status: "Holiday", minutes: 0, details: [] };
      return { key, status: "Absent", minutes: 0, details: [] };
    };

    // ---- Month: one entry per day (calendar) ----
    const days = [];
    const monthTotals = emptyTotals();
    for (let d = 1; d <= daysInMonth(year, month); d++) {
      const s = statusOfDay(year, month, d);
      addToTotals(monthTotals, s.status, s.minutes);
      days.push({
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
        addToTotals(t, s.status, s.minutes);
        addToTotals(yearTotals, s.status, s.minutes);
      }
      yearSummary.push({ month: m, label: MONTH_NAMES[m - 1], ...finishTotals(t) });
    }

    res.status(200).json({
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

module.exports = { getAttendanceReport, _internal: { combineDay, finishTotals } };
