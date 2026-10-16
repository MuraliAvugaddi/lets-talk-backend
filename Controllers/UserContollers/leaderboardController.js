const mongoose = require("mongoose");
const Attendance = require("../../Models/attendance");
const User = require("../../Models/users");
const { istParts, istDayRange } = require("../../utils/time");
const { ADMIN_ROLES, STAFF_ROLES } = require("../../utils/normalize");

// =====================================================
// LEADERBOARD — best trainer / best student of the month or year
// GET /api/leaderboard?role=teacher|student&period=month|year&year=2026&month=10&limit=10
//
// Ranking (same rule for trainers and students):
//   1. attendance %  = days attended (Present/Late/Partial) ÷ working days
//   2. more Present days (on time beats late)
//   3. more minutes in class
// People with fewer than MIN_WORKING_DAYS working days in the period (just joined) are not ranked.
// One Mongo aggregation → fast even with 2,000 students.
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
  // safety: max ~370 iterations
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

    // Per person: days attended (best status per day), present / late / partial days, minutes
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
        phone: isAdmin ? u.phone : undefined, // students/trainers only see names
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
    }

    rankPeople(people);
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
      winner: people[0] || null,
      ranking: people.slice(0, limit),
      me: meIdx >= 0 ? people[meIdx] : null,
    });
  } catch (error) {
    console.error("Leaderboard Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { getLeaderboard, _internal: { countWorkingDays, rankPeople } };
