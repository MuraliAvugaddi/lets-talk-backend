const mongoose = require("mongoose");
const Attendance = require("../../Models/attendance");
const User = require("../../Models/users");
const Practice = require("../../Models/practice");
const Result = require("../../Models/result");
const { istParts, istDayRange } = require("../../utils/time");
const { ADMIN_ROLES, STAFF_ROLES } = require("../../utils/normalize");

// =====================================================
// LEADERBOARD — best trainer / best student of the month or year
// GET /api/leaderboard?role=teacher|student&period=month|year&year=2026&month=10&limit=10
// =====================================================

const WEEKLY_OFF = String(process.env.WEEKLY_OFF ?? "0")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "")
  .map(Number)
  .filter((n) => n >= 0 && n <= 6);

const DAY_CLOSE_MINUTES = 20 * 60 + 15;
const MIN_WORKING_DAYS = 3;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n) => String(n).padStart(2, "0");
const keyOf = (y, m, d) => `${pad(d)}-${pad(m)}-${y}`;
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// Working days for one person between two (y,m,d) numbers, inclusive
const countWorkingDays = (fromNum, toNum) => {
  if (toNum < fromNum) return 0;
  let count = 0;
  let y = Math.floor(fromNum / 10000);
  let m = Math.floor((fromNum % 10000) / 100);
  let d = fromNum % 100;
  for (let i = 0; i < 400; i++) {
    const num = y * 10000 + m * 100 + d;
    if (num > toNum) break;
    if (!WEEKLY_OFF.includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay())) count += 1;
    d += 1;
    if (d > daysInMonth(y, m)) {
      d = 1;
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
  }
  return count;
};

// ⭐ Students: overall score = attendance 50% + speaking practice 30% + tests 20%
const WEIGHTS = { attendance: 50, practice: 30, tests: 20 };
const overallScore = ({ percentage = 0, practicePct = 0, testPct = 0 }) =>
  Math.round((percentage * WEIGHTS.attendance + practicePct * WEIGHTS.practice + testPct * WEIGHTS.tests) / 100);

const rankStudents = (people) =>
  people.sort(
    (a, b) =>
      b.score - a.score ||
      b.percentage - a.percentage ||
      b.practiceAvg - a.practiceAvg ||
      b.testAvg - a.testAvg ||
      b.minutes - a.minutes ||
      a.name.localeCompare(b.name)
  );

const rankPeople = (people) =>
  people.sort(
    (a, b) =>
      b.percentage - a.percentage || b.present - a.present || b.minutes - a.minutes || a.name.localeCompare(b.name)
  );

const getLeaderboard = async (req, res) => {
  try {
    const role = String(req.query.role || "student").toLowerCase() === "teacher" ? "teacher" : "student";
    const period = String(req.query.period || "month").toLowerCase() === "year" ? "year" : "month";
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);

    const now = istParts(new Date());
    const year = Number(req.query.year) || now.year;
    const month = Math.min(Math.max(Number(req.query.month) || now.month, 1), 12);
    if (year < 2020 || year > now.year) return res.status(400).json({ message: "Invalid year" });

    const firstMonth = period === "year" ? 1 : month;
    const lastMonth = period === "year" ? 12 : month;
    const periodStartNum = year * 10000 + firstMonth * 100 + 1;
    let periodEndNum = year * 10000 + lastMonth * 100 + daysInMonth(year, lastMonth);

    // Don't count today until the day is over, nor any future day
    const todayNum = now.year * 10000 + now.month * 100 + now.day;
    const lastClosedNum =
      now.hour * 60 + now.minute >= DAY_CLOSE_MINUTES
        ? todayNum
        : (() => {
            const t = new Date(Date.UTC(now.year, now.month - 1, now.day - 1));
            return t.getUTCFullYear() * 10000 + (t.getUTCMonth() + 1) * 100 + t.getUTCDate();
          })();
    periodEndNum = Math.min(periodEndNum, lastClosedNum);

    const periodLabel = period === "year" ? `${year}` : `${MONTH_NAMES[month - 1]} ${year}`;
    if (periodEndNum < periodStartNum) {
      return res.status(200).json({ role, period, year, month, periodLabel, winner: null, ranking: [], me: null });
    }

    const { start } = istDayRange(keyOf(year, firstMonth, 1));
    const { end } = istDayRange(
      keyOf(Math.floor(periodEndNum / 10000), Math.floor((periodEndNum % 10000) / 100), periodEndNum % 100)
    );

    const roles = role === "teacher" ? STAFF_ROLES.filter((r) => r === "teacher") : ["student"];
    const users = await User.find({ role: { $in: roles }, createdAt: { $lte: end } })
      .select("name phone mode language teacherStage createdAt")
      .lean();
    if (!users.length) {
      return res.status(200).json({ role, period, year, month, periodLabel, winner: null, ranking: [], me: null });
    }

    const stats = await Attendance.aggregate([
      {
        $match: {
          userId: { $in: users.map((u) => new mongoose.Types.ObjectId(String(u._id))) },
          createdAt: { $gte: start, $lte: end },
          status: { $in: ["Present", "Late", "Partial"] },
        },
      },
      {
        $group: {
          _id: { u: "$userId", d: "$date" },
          best: {
            $max: {
              $switch: {
                branches: [
                  { case: { $eq: ["$status", "Present"] }, then: 3 },
                  { case: { $eq: ["$status", "Late"] }, then: 2 },
                ],
                default: 1,
              },
            },
          },
          minutes: { $sum: { $ifNull: ["$totalMinutesSpent", 0] } },
        },
      },
      {
        $group: {
          _id: "$_id.u",
          present: { $sum: { $cond: [{ $eq: ["$best", 3] }, 1, 0] } },
          late: { $sum: { $cond: [{ $eq: ["$best", 2] }, 1, 0] } },
          partial: { $sum: { $cond: [{ $eq: ["$best", 1] }, 1, 0] } },
          minutes: { $sum: "$minutes" },
        },
      },
    ]);
    const statMap = new Map(stats.map((s) => [String(s._id), s]));

    let practiceMap = new Map();
    let testMap = new Map();
    if (role === "student") {
      const ids = users.map((u) => new mongoose.Types.ObjectId(String(u._id)));
      const [practiceStats, testStats] = await Promise.all([
        Practice.aggregate([
          { $match: { userId: { $in: ids }, practicedAt: { $gte: start, $lte: end } } },
          {
            $group: {
              _id: "$userId",
              count: { $sum: 1 },
              rated: { $sum: { $cond: [{ $gt: ["$rating", 0] }, 1, 0] } },
              ratingSum: { $sum: { $cond: [{ $gt: ["$rating", 0] }, "$rating", 0] } },
            },
          },
        ]),
        Result.aggregate([
          { $match: { userId: { $in: ids }, completedAt: { $gte: start, $lte: end }, totalQuestions: { $gt: 0 } } },
          {
            $group: {
              _id: "$userId",
              count: { $sum: 1 },
              pct: { $avg: { $multiply: [{ $divide: ["$score", "$totalQuestions"] }, 100] } },
            },
          },
        ]),
      ]);
      practiceMap = new Map(practiceStats.map((p) => [String(p._id), p]));
      testMap = new Map(testStats.map((t) => [String(t._id), t]));
    }

    const isAdmin = ADMIN_ROLES.includes(req.user.role);
    const people = [];
    for (const u of users) {
      const j = istParts(u.createdAt || new Date(0));
      const joinedNum = j.year * 10000 + j.month * 100 + j.day;
      const workingDays = countWorkingDays(Math.max(periodStartNum, joinedNum), periodEndNum);
      if (workingDays < MIN_WORKING_DAYS) continue;

      const s = statMap.get(String(u._id)) || { present: 0, late: 0, partial: 0, minutes: 0 };
      const attended = Math.min(s.present + s.late + s.partial, workingDays);
      people.push({
        userId: u._id,
        name: u.name,
        phone: isAdmin ? u.phone : undefined,
        mode: u.mode,
        language: u.language,
        stage: role === "teacher" ? u.teacherStage : undefined,
        present: s.present,
        late: s.late,
        partial: s.partial,
        absent: Math.max(workingDays - attended, 0),
        attended,
        workingDays,
        minutes: s.minutes,
        hours: Math.round((s.minutes / 60) * 10) / 10,
        percentage: Math.round((attended / workingDays) * 100),
      });

      if (role === "student") {
        const p = people[people.length - 1];
        const pr = practiceMap.get(String(u._id)) || { count: 0, rated: 0, ratingSum: 0 };
        const tr = testMap.get(String(u._id)) || { count: 0, pct: 0 };
        p.practiceCount = pr.count;
        p.practiceAvg = pr.rated ? Math.round((pr.ratingSum / pr.rated) * 10) / 10 : 0;
        p.testCount = tr.count;
        p.testAvg = tr.count ? Math.round(tr.pct) : 0;
        p.score = overallScore({
          percentage: p.percentage,
          practicePct: (p.practiceAvg / 5) * 100,
          testPct: p.testAvg,
        });
      }
    }

    if (role === "student") rankStudents(people);
    else rankPeople(people);
    people.forEach((p, i) => {
      p.rank = i + 1;
    });

    const meIdx = people.findIndex((p) => String(p.userId) === String(req.user._id));

    res.status(200).json({
      role,
      period,
      year,
      month,
      periodLabel,
      totalRanked: people.length,
      scoring: role === "student" ? WEIGHTS : null,
      winner: people[0] || null,
      ranking: people.slice(0, limit),
      me: meIdx >= 0 ? people[meIdx] : null,
    });
  } catch (error) {
    console.error("Leaderboard Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// ⭐ TOP RATED — students with the best speaking-practice ratings
// GET /api/leaderboard/ratings?period=month|year&year=2026&month=10&language=English&stage=all|stage1&limit=50
// =====================================================
const MIN_RATINGS = { month: 3, year: 6 };
const STAGES = ["stage1", "stage2", "stage3", "stage4", "stage5", "stage6", "stage7"];

const round1 = (n) => Math.round(n * 10) / 10;

const rankRatings = (rows, minRatings) =>
  rows
    .map((r) => ({ ...r, avg: r.rated ? round1(r.sum / r.rated) : 0, qualified: r.rated >= minRatings }))
    .sort(
      (a, b) =>
        Number(b.qualified) - Number(a.qualified) ||
        b.avg - a.avg ||
        b.rated - a.rated ||
        b.fiveStar - a.fiveStar ||
        String(a.name).localeCompare(String(b.name))
    )
    .map((r, i) => ({ ...r, rank: i + 1 }));

const topTags = (tagLists, n = 3) => {
  const count = new Map();
  for (const list of tagLists || []) for (const t of list || []) count.set(t, (count.get(t) || 0) + 1);
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([t]) => t);
};

const getRatingLeaderboard = async (req, res) => {
  try {
    const period = String(req.query.period || "month").toLowerCase() === "year" ? "year" : "month";
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const language = String(req.query.language || "English").toLowerCase() === "hindi" ? "Hindi" : "English";
    const stageQ = String(req.query.stage || "all").toLowerCase();
    const stage = STAGES.includes(stageQ) ? stageQ : "all";

    const now = istParts(new Date());
    const year = Number(req.query.year) || now.year;
    const month = Math.min(Math.max(Number(req.query.month) || now.month, 1), 12);
    if (year < 2020 || year > now.year) return res.status(400).json({ message: "Invalid year" });

    const firstMonth = period === "year" ? 1 : month;
    const lastMonth = period === "year" ? 12 : month;
    const { start } = istDayRange(keyOf(year, firstMonth, 1));
    const { end } = istDayRange(keyOf(year, lastMonth, daysInMonth(year, lastMonth)));
    const periodLabel = period === "year" ? `${year}` : `${MONTH_NAMES[month - 1]} ${year}`;
    const minRatings = MIN_RATINGS[period];

    const match = { rating: { $gt: 0 }, practicedAt: { $gte: start, $lte: end }, language };
    if (stage !== "all") match.stage = stage;

    const [perStudent, perStage] = await Promise.all([
      Practice.aggregate([
        { $match: match },
        { $sort: { practicedAt: 1 } },
        {
          $group: {
            _id: "$userId",
            name: { $last: "$userName" },
            sum: { $sum: "$rating" },
            rated: { $sum: 1 },
            fiveStar: { $sum: { $cond: [{ $gte: ["$rating", 5] }, 1, 0] } },
            stages: { $addToSet: "$stage" },
            section: { $last: "$section" },
            tags: { $push: "$tags" },
            lastNote: { $last: "$note" },
            lastTrainer: { $last: "$trainerName" },
            lastAt: { $last: "$practicedAt" },
          },
        },
      ]),
      Practice.aggregate([
        { $match: { ...match, stage: { $in: STAGES } } },
        { $sort: { practicedAt: 1 } },
        {
          $group: {
            _id: { u: "$userId", s: "$stage" },
            name: { $last: "$userName" },
            sum: { $sum: "$rating" },
            rated: { $sum: 1 },
            fiveStar: { $sum: { $cond: [{ $gte: ["$rating", 5] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const ids = perStudent.map((r) => r._id);
    const users = await User.find({ _id: { $in: ids } }).select("name phone onlineSection mode").lean();
    const userMap = new Map(users.map((u) => [String(u._id), u]));
    const isAdmin = ADMIN_ROLES.includes(req.user.role);

    const ranked = rankRatings(
      perStudent.map((r) => {
        const u = userMap.get(String(r._id)) || {};
        return {
          userId: r._id,
          name: u.name || r.name || "Student",
          phone: isAdmin ? u.phone || "" : undefined,
          mode: u.mode || "",
          section: r.section || u.onlineSection || "",
          sum: r.sum,
          rated: r.rated,
          fiveStar: r.fiveStar,
          stages: (r.stages || []).sort(),
          topTags: topTags(r.tags),
          lastNote: r.lastNote || "",
          lastTrainer: r.lastTrainer || "",
          lastAt: r.lastAt,
        };
      }),
      minRatings
    ).map(({ sum, ...rest }) => rest);

    const bestByStage = STAGES.map((s) => {
      const rows = perStage
        .filter((r) => r._id.s === s)
        .map((r) => ({
          userId: r._id.u,
          name: (userMap.get(String(r._id.u)) || {}).name || r.name || "Student",
          sum: r.sum,
          rated: r.rated,
          fiveStar: r.fiveStar,
        }));
      const top = rankRatings(rows, minRatings)[0];
      if (!top) return { stage: s, winner: null, students: 0 };
      const { sum, ...winner } = top;
      return { stage: s, winner, students: rows.length };
    });

    const meIdx = ranked.findIndex((p) => String(p.userId) === String(req.user._id));
    const winner = ranked.find((r) => r.qualified) || null;

    res.status(200).json({
      period,
      year,
      month,
      periodLabel,
      language,
      stage,
      minRatings,
      totalRated: ranked.length,
      totalRatings: ranked.reduce((a, r) => a + r.rated, 0),
      winner,
      ranking: ranked.slice(0, limit),
      bestByStage,
      me: meIdx >= 0 ? ranked[meIdx] : null,
    });
  } catch (error) {
    console.error("Rating leaderboard error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = {
  getLeaderboard,
  getRatingLeaderboard,
  _internal: { countWorkingDays, rankPeople, rankStudents, overallScore, rankRatings, topTags },
};