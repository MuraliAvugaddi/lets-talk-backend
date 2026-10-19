const crypto = require("crypto");
const ClassMode = require("../../Models/classMode");
const { getModes, invalidate, parseTime, formatTime } = require("../../utils/classMode");
const Attendance = require("../../Models/attendance");
const User = require("../../Models/users");
const { dateKey, normalizeDateKey, legacyDateVariants } = require("../../utils/time");
const { normStage, normLanguage, STAFF_ROLES } = require("../../utils/normalize");
const { enabledStageTimings } = require("../../utils/batches");

// =====================================================
// SPECIAL CLASS DAYS (admin)
//   GET  /api/class-mode                 → { rain, assembly }  (apps read this)
//   POST /api/class-mode/rain            { active: true|false, note? }
//   POST /api/class-mode/assembly        { active: true|false, title?, startTime: "11:00 AM", note? }
// Both stay on until the admin removes them.
//   rain body may include { reason: "Heavy rain" } — shown to trainers and students.
// =====================================================

const view = (d) =>
  d
    ? {
        active: !!d.active,
        title: d.title || "",
        note: d.note || "",
        startTime: d.startTime || "",
        startMinutes: d.startMinutes || 0,
        sessionKey: d.sessionKey || "",
        startedAt: d.startedAt,
        startedByName: d.startedByName || "",
      }
    : null;

// The new state travels WITH the socket event, so 2,500 apps update instantly
// without all calling the server back at the same second.
const broadcast = async (req) => {
  if (!req.io) return;
  const modes = await getModes({ fresh: true });
  req.io.emit("class_mode_update", { at: Date.now(), rain: view(modes.rain), assembly: view(modes.assembly) });
};

const getClassModes = async (req, res) => {
  try {
    const modes = await getModes();
    res.status(200).json({ rain: view(modes.rain), assembly: view(modes.assembly) });
  } catch (error) {
    console.error("Get class modes error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const setMode = async (req, res, kind) => {
  try {
    const active = req.body && req.body.active === true;
    const update = { active };
    if (active) {
      update.startedAt = new Date();
      update.startedBy = req.user ? req.user._id : null;
      update.startedByName = req.user ? req.user.name || "" : "";
      update.endedAt = null;
      update.sessionKey = crypto.randomBytes(3).toString("hex"); // fresh live call every time
      // Why offline classes are online today ("Heavy rain", "Festival", …) / note for the special class
      update.note = String(req.body.reason || req.body.note || "").slice(0, 300);
      if (kind === "assembly") {
        const minutes = parseTime(req.body.startTime);
        if (minutes === null) return res.status(400).json({ message: "Pick a start time, e.g. 11:00 AM" });
        update.startMinutes = minutes;
        update.startTime = formatTime(minutes);
        update.title = String(req.body.title || "").trim().slice(0, 120) || "Surendra Sir Special Class";
      }
    } else {
      update.endedAt = new Date();
    }

    const doc = await ClassMode.findOneAndUpdate({ kind }, { $set: update }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true });
    invalidate();
    if (kind === "assembly") require("./streamController").forgetAssembly();
    await broadcast(req);
    res.status(200).json({
      message: active
        ? kind === "rain"
          ? `Offline classes are online now${doc.note ? ` (${doc.note})` : ""}`
          : `${doc.title} set for ${doc.startTime}`
        : "Back to normal classes",
      [kind]: view(doc),
    });
  } catch (error) {
    console.error(`Set ${kind} mode error:`, error);
    res.status(500).json({ message: "Server Error" });
  }
};

const setRainMode = (req, res) => setMode(req, res, "rain");
const setAssemblyMode = (req, res) => setMode(req, res, "assembly");

// =====================================================
// 📋 SPECIAL CLASS ATTENDANCE REPORT (admin)
//   GET /api/class-mode/assembly/report?date=DD-MM-YYYY   (default today)
//   → everyone who should attend (trainers + students with any stage),
//     present or absent, with language / stage / online-offline for grouping.
//   GET /api/class-mode/assembly/people  → ids of trainers & staff
//     (the live host screen uses it to split Trainers / Students)
// =====================================================
const RANK = { Present: 3, Late: 2, Partial: 1, Absent: 0 };

// Pure: users + attendance records → report rows (tested in classmode.test.js)
const buildAssemblyReport = (users, records) => {
  const byUser = new Map();
  for (const r of records) {
    const id = String(r.userId);
    const cur = byUser.get(id) || { status: "Absent", minutes: 0, joinedAt: null, inClass: false };
    const st = r.status && r.status !== "Absent" ? r.status : r.arrivalStatus && r.arrivalStatus !== "Absent" ? r.arrivalStatus : "Present";
    if ((RANK[st] || 0) > (RANK[cur.status] || 0)) cur.status = st;
    cur.minutes = Math.max(cur.minutes, Number(r.totalMinutesSpent) || 0);
    const j = r.firstJoinAt ? new Date(r.firstJoinAt) : null;
    if (j && (!cur.joinedAt || j < cur.joinedAt)) cur.joinedAt = j;
    if (r.joinTime) cur.inClass = true;
    byUser.set(id, cur);
  }

  const people = users.map((u) => {
    const id = String(u._id);
    const isStudent = u.role === "student";
    let classes = isStudent ? enabledStageTimings(u).map((t) => ({ language: t.language, stage: t.stage })) : [];
    if (!classes.length) {
      classes = [{ language: normLanguage(u.language) || "English", stage: normStage(u.teacherStage) || "stage1" }];
    }
    const rec = byUser.get(id);
    return {
      id,
      name: u.name || "",
      phone: u.phone || "",
      role: isStudent ? "student" : "trainer",
      staffRole: isStudent ? "" : u.role,
      mode: u.mode === "offline" ? "offline" : "online",
      section: u.onlineSection || "",
      classes,
      present: !!rec,
      status: rec ? rec.status : "Absent",
      minutes: rec ? rec.minutes : 0,
      joinedAt: rec ? rec.joinedAt : null,
      inClass: rec ? rec.inClass : false,
    };
  });
  people.sort((a, b) => (a.present === b.present ? a.name.localeCompare(b.name) : a.present ? -1 : 1));

  const count = (role) => {
    const list = people.filter((p) => p.role === role);
    const present = list.filter((p) => p.present).length;
    return { total: list.length, present, absent: list.length - present };
  };
  return { people, summary: { trainers: count("trainer"), students: count("student") } };
};

const STAGE_ACCESS = ["englishAccess", "hindiAccess"].flatMap((f) =>
  [1, 2, 3, 4, 5, 6, 7].map((n) => ({ [`${f}.stage${n}`]: true }))
);
const USER_FIELDS = "name phone mode role language teacherStage onlineSection batchTime englishBatch hindiBatch englishAccess hindiAccess";

const getAssemblyReport = async (req, res) => {
  try {
    const date = normalizeDateKey(String(req.query.date || "")) || dateKey(new Date());
    const records = await Attendance.find({ date: { $in: legacyDateVariants(date) }, classMode: "assembly" })
      .select("userId status arrivalStatus totalMinutesSpent firstJoinAt joinTime")
      .lean();

    // Who should attend: trainers + every student with at least one stage
    const users = await User.find({ $or: [{ role: "teacher" }, { role: "student", $or: STAGE_ACCESS }] })
      .select(USER_FIELDS)
      .lean();
    // + anyone who attended but isn't in that list (stage removed later, staff, …) — not the host admins
    const known = new Set(users.map((u) => String(u._id)));
    const extraIds = [...new Set(records.map((r) => String(r.userId)))].filter((id) => !known.has(id));
    if (extraIds.length) {
      const extra = await User.find({ _id: { $in: extraIds }, role: { $in: ["student", "teacher"] } })
        .select(USER_FIELDS)
        .lean();
      users.push(...extra);
    }

    const modes = await getModes();
    const a = modes.assembly;
    const { people, summary } = buildAssemblyReport(users, records);
    res.status(200).json({
      date,
      title: (a && a.title) || "Surendra Sir Special Class",
      startTime: (a && a.startTime) || "",
      active: !!a,
      held: records.length > 0,
      summary,
      people,
    });
  } catch (error) {
    console.error("Special class report error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// Trainer / staff ids — cached 2 min (the host screen asks once when it opens)
let peopleCache = null;
let peopleAt = 0;
const getAssemblyPeople = async (req, res) => {
  try {
    if (!peopleCache || Date.now() - peopleAt > 120000) {
      const staff = await User.find({ role: { $in: STAFF_ROLES } }).select("_id role").lean();
      peopleCache = {
        trainers: staff.filter((u) => u.role === "teacher").map((u) => String(u._id)),
        staff: staff.filter((u) => u.role !== "teacher").map((u) => String(u._id)),
      };
      peopleAt = Date.now();
    }
    res.status(200).json(peopleCache);
  } catch (error) {
    console.error("Special class people error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = {
  getClassModes,
  setRainMode,
  setAssemblyMode,
  getAssemblyReport,
  getAssemblyPeople,
  _report: { buildAssemblyReport },
};
