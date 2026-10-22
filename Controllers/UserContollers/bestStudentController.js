const mongoose = require("mongoose");
const Attendance = require("../../Models/attendance");
const User = require("../../Models/users");
const Practice = require("../../Models/practice");
const Result = require("../../Models/result");
const { istParts, istDayRange } = require("../../utils/time");
const { normStage, normLanguage, normSection, ADMIN_ROLES } = require("../../utils/normalize");
const { enabledStageTimings } = require("../../utils/batches");

// =====================================================
// 🏆 BEST STUDENT OF THE MONTH — per class + per language
// GET /api/leaderboard/best-students?year=2026&month=10
//
// Classes (each has its own best student):
//   • English ONLINE  → per stage + section   ("English • Stage 1 • Online • Section B")
//   • English OFFLINE → per stage             (offline has no sections)
//   • Hindi           → per stage + online / offline
// Plus ONE best student for ALL of English (every stage, online + offline) and ONE for ALL of Hindi.
//
// Score (0–100) = attendance 50% + trainer speaking-practice stars 30% (avg ÷ 5) + test average 20%
// For a class, only that language + stage counts. A student with 2 stages is in 2 classes.
// Students only — trainers are never part of this list.
// Who sees what: everyone gets all classes; `mine: true` marks the student's own classes
// (or the trainer's own class). Phone numbers only for admins.
// =====================================================

const WEEKLY_OFF = String(process.env.WEEKLY_OFF ?? "0")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "")
  .map(Number)
  .filter((n) => n >= 0 && n <= 6);
const DAY_CLOSE_MINUTES = 20 * 60 + 15;
const MIN_WORKING_DAYS = 3;
const TOP_N = 10;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEIGHTS = { attendance: 50, practice: 30, tests: 20 };

const pad = (n) => String(n).padStart(2, "0");
const keyOf = (y, m, d) => `${pad(d)}-${pad(m)}-${y}`;
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

const countWorkingDays = (y, m, fromDay, toDay) => {
  let n = 0;
  for (let d = fromDay; d <= toDay; d++) if (!WEEKLY_OFF.includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay())) n++;
  return n;
};

const round1 = (n) => Math.round(n * 10) / 10;
const scoreOf = ({ percentage = 0, practiceAvg = 0, testAvg = 0 }) =>
  Math.round(
    (percentage * WEIGHTS.attendance + ((practiceAvg / 5) * 100) * WEIGHTS.practice + testAvg * WEIGHTS.tests) / 100
  );

const rank = (list) =>
  list.sort(
    (a, b) =>
      b.score - a.score ||
      b.percentage - a.percentage ||
      b.practiceAvg - a.practiceAvg ||
      b.testAvg - a.testAvg ||
      b.minutes - a.minutes ||
      a.name.localeCompare(b.name)
  );

// Class of one student for one language + stage (pure, tested)
const classKey = (user, language, stage) => {
  const mode = user.mode === "offline" ? "offline" : "online";
  const section = language === "English" && mode === "online" ? normSection(user.onlineSection) : "";
  const n = String(stage).replace("stage", "");
  const label =
    language === "English" && mode === "online"
      ? `English • Stage ${n} • Online • ${section === "None" ? "No section" : `Section ${section}`}`
      : `${language} • Stage ${n} • ${mode === "online" ? "Online" : "Offline"}`;
  return { key: `${language}|${stage}|${mode}|${section}`, language, stage, mode, section, label };
};

// The trainer's own class key (to mark `mine`)
const trainerClassKey = (u) => {
  const language = normLanguage(u.language) || "English";
  const stage = normStage(u.teacherStage) || "stage1";
  return classKey({ mode: u.mode, onlineSection: u.teacherSection }, language, stage).key;
};

let cache = { key: "", at: 0, data: null };
const CACHE_MS = 2 * 60 * 1000;
const computing = new Map(); // month → Promise (in progress)

const computeMonth = async (year, month) => {
  const now = istParts(new Date());
  const isCurrent = year === now.year && month === now.month;
  let lastDay = daysInMonth(year, month);
  if (isCurrent) lastDay = now.hour * 60 + now.minute >= DAY_CLOSE_MINUTES ? now.day : now.day - 1;
  if (lastDay < 1) return { classes: [], overall: [] };

  const { start } = istDayRange(keyOf(year, month, 1));
  const { end } = istDayRange(keyOf(year, month, lastDay));

  const anyAccess = ["englishAccess", "hindiAccess"].flatMap((f) =>
    [1, 2, 3, 4, 5, 6, 7].map((n) => ({ [`${f}.stage${n}`]: true }))
  );
  const users = await User.find({ role: "student", createdAt: { $lte: end }, $or: anyAccess })
    .select("name phone mode onlineSection englishAccess hindiAccess createdAt")
    .lean();
  if (!users.length) return { classes: [], overall: [] };
  const ids = users.map((u) => new mongoose.Types.ObjectId(String(u._id)));
  const attendedMatch = {
    userId: { $in: ids },
    createdAt: { $gte: start, $lte: end },
    status: { $in: ["Present", "Late", "Partial"] },
  };

  const [byStage, byLang, practice, tests] = await Promise.all([
    // days attended per student + language + stage
    Attendance.aggregate([
      { $match: attendedMatch },
      {
        $group: {
          _id: { u: "$userId", l: "$language", s: "$stage", d: "$date" },
          minutes: { $sum: { $ifNull: ["$totalMinutesSpent", 0] } },
        },
      },
      { $group: { _id: { u: "$_id.u", l: "$_id.l", s: "$_id.s" }, days: { $sum: 1 }, minutes: { $sum: "$minutes" } } },
    ]),
    // days attended per student + language (two stages on one day = one day)
    Attendance.aggregate([
      { $match: attendedMatch },
      {
        $group: {
          _id: { u: "$userId", l: "$language", d: "$date" },
          minutes: { $sum: { $ifNull: ["$totalMinutesSpent", 0] } },
        },
      },
      { $group: { _id: { u: "$_id.u", l: "$_id.l" }, days: { $sum: 1 }, minutes: { $sum: "$minutes" } } },
    ]),
    Practice.aggregate([
      { $match: { userId: { $in: ids }, practicedAt: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: { u: "$userId", l: "$language", s: "$stage" },
          count: { $sum: 1 },
          rated: { $sum: { $cond: [{ $gt: ["$rating", 0] }, 1, 0] } },
          sum: { $sum: { $cond: [{ $gt: ["$rating", 0] }, "$rating", 0] } },
        },
      },
    ]),
    Result.aggregate([
      { $match: { userId: { $in: ids }, completedAt: { $gte: start, $lte: end }, totalQuestions: { $gt: 0 } } },
      {
        $group: {
          _id: { u: "$userId", l: "$language", s: "$stage" },
          count: { $sum: 1 },
          pctSum: { $sum: { $multiply: [{ $divide: ["$score", "$totalQuestions"] }, 100] } },
        },
      },
    ]),
  ]);

  // maps: "u|lang|stage" and "u|lang"
  const add = (map, key, obj) => {
    const cur = map.get(key) || {};
    for (const [k, v] of Object.entries(obj)) cur[k] = (cur[k] || 0) + (v || 0);
    map.set(key, cur);
  };
  const stageMap = new Map();
  const langMap = new Map();
  for (const r of byStage) {
    const l = normLanguage(r._id.l) || "English";
    add(stageMap, `${r._id.u}|${l}|${normStage(r._id.s) || r._id.s}`, { days: r.days, minutes: r.minutes });
  }
  for (const r of byLang) {
    const l = normLanguage(r._id.l) || "English";
    add(langMap, `${r._id.u}|${l}`, { days: r.days, minutes: r.minutes });
  }
  for (const r of practice) {
    const l = normLanguage(r._id.l) || "English";
    const s = normStage(r._id.s) || r._id.s;
    add(stageMap, `${r._id.u}|${l}|${s}`, { pCount: r.count, pRated: r.rated, pSum: r.sum });
    add(langMap, `${r._id.u}|${l}`, { pCount: r.count, pRated: r.rated, pSum: r.sum });
  }
  for (const r of tests) {
    const l = normLanguage(r._id.l) || "English";
    const s = normStage(r._id.s) || r._id.s;
    add(stageMap, `${r._id.u}|${l}|${s}`, { tCount: r.count, tSum: r.pctSum });
    add(langMap, `${r._id.u}|${l}`, { tCount: r.count, tSum: r.pctSum });
  }

  const entry = (u, stats, workingDays) => {
    const s = stats || {};
    const attended = Math.min(s.days || 0, workingDays);
    const e = {
      userId: String(u._id),
      name: u.name,
      phone: u.phone,
      mode: u.mode === "offline" ? "offline" : "online",
      section: normSection(u.onlineSection),
      attended,
      workingDays,
      percentage: workingDays ? Math.round((attended / workingDays) * 100) : 0,
      minutes: s.minutes || 0,
      practiceCount: s.pCount || 0,
      practiceAvg: s.pRated ? round1(s.pSum / s.pRated) : 0,
      testCount: s.tCount || 0,
      testAvg: s.tCount ? Math.round(s.tSum / s.tCount) : 0,
    };
    e.score = scoreOf(e);
    return e;
  };

  const classes = new Map(); // key → { ...meta, people: [] }
  const overall = { English: [], Hindi: [] };
  for (const u of users) {
    const j = istParts(u.createdAt || new Date(0));
    const joinedThisMonth = j.year === year && j.month === month;
    const fromDay = joinedThisMonth ? j.day : 1;
    const workingDays = countWorkingDays(year, month, fromDay, lastDay);
    if (workingDays < MIN_WORKING_DAYS) continue;

    const langs = new Set();
    for (const t of enabledStageTimings(u)) {
      langs.add(t.language);
      const c = classKey(u, t.language, t.stage);
      if (!classes.has(c.key)) classes.set(c.key, { ...c, people: [] });
      classes.get(c.key).people.push(entry(u, stageMap.get(`${u._id}|${t.language}|${t.stage}`), workingDays));
    }
    for (const l of langs) overall[l].push(entry(u, langMap.get(`${u._id}|${l}`), workingDays));
  }

  const finish = (people) => {
    rank(people);
    people.forEach((p, i) => (p.rank = i + 1));
    return people;
  };
  const order = (c) => `${c.language === "English" ? 0 : 1}${c.stage}${c.mode === "online" ? 0 : 1}${c.section}`;
  return {
    classes: [...classes.values()].map((c) => ({ ...c, people: finish(c.people) })).sort((a, b) => order(a).localeCompare(order(b))),
    overall: ["English", "Hindi"].map((language) => ({
      language,
      label: `${language} — all stages, online + offline`,
      people: finish(overall[language]),
    })),
  };
};

// Shape for one viewer: top 10 + "my" rank, phones only for admins, winner needs a score > 0
const viewFor = (people, viewerId, isAdmin) => {
  const strip = (p) => (isAdmin ? p : { ...p, phone: undefined });
  const me = viewerId ? people.find((p) => p.userId === viewerId) : null;
  const winner = people[0] && people[0].score > 0 ? strip(people[0]) : null;
  return { totalRanked: people.length, winner, top: people.slice(0, TOP_N).map(strip), me: me ? strip(me) : null };
};

const getBestStudents = async (req, res) => {
  try {
    const now = istParts(new Date());
    const year = Number(req.query.year) || now.year;
    const month = Math.min(Math.max(Number(req.query.month) || now.month, 1), 12);
    if (year < 2020 || year * 12 + month > now.year * 12 + now.month) {
      return res.status(400).json({ message: "Pick this month or an earlier one" });
    }

    const ck = `${year}-${month}`;
    if (cache.key !== ck || Date.now() - cache.at > CACHE_MS || req.query.fresh === "1") {
      // many students at once → ONE computation (the others wait for the same result)
      if (!computing.has(ck)) {
        computing.set(ck, computeMonth(year, month).finally(() => computing.delete(ck)));
      }
      const data = await computing.get(ck);
      cache = { key: ck, at: Date.now(), data };
    }
    const { classes, overall } = cache.data;

    const viewer = req.user || {};
    const isAdmin = ADMIN_ROLES.includes(viewer.role);
    const viewerId = viewer._id ? String(viewer._id) : "";
    let myClassKey = "";
    if (viewer.role === "teacher") {
      const t = await User.findById(viewerId).select("language teacherStage teacherSection mode").lean();
      if (t) myClassKey = trainerClassKey(t);
    }

    res.status(200).json({
      year,
      month,
      periodLabel: `${MONTH_NAMES[month - 1]} ${year}`,
      scoring: WEIGHTS,
      overall: overall.map((o) => ({ language: o.language, label: o.label, ...viewFor(o.people, viewerId, isAdmin) })),
      classes: classes.map((c) => {
        const v = viewFor(c.people, viewerId, isAdmin);
        return {
          key: c.key,
          language: c.language,
          stage: c.stage,
          mode: c.mode,
          section: c.section,
          label: c.label,
          ...v,
          mine: viewer.role === "teacher" ? c.key === myClassKey : !!v.me,
        };
      }),
    });
  } catch (error) {
    console.error("Best students error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { getBestStudents, _internal: { classKey, scoreOf, rank, viewFor } };
