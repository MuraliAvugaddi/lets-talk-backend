// =====================================================
// 🎓 PROMOTE — move students to the next stage in one tap
//
//   GET  /api/admin/promote/candidates?language=English&stage=stage1&section=A&mode=online&q=
//        → students whose CURRENT stage is this one (+ attendance % in it)
//        &view=promoted → students who already FINISHED this stage (+ the stage they are in now)
//        summary: { left, promoted, dropped } for this stage
//
//   POST /api/admin/promote  { userIds: [...], language: "English", stage?: "stage1" }
//        For every student:
//          • old stage → FINISHED  (study material stays open, no live class / attendance / tests)
//          • next stage → CURRENT  (live class, attendance, tests, reminders)
//          • class timing of the old stage moves to the new stage
//          • stage 7 finished → course completed (all material open, no live class)
//        stage left out → each student's highest current stage is used.
// =====================================================
const mongoose = require("mongoose");
const User = require("../../Models/users");
const Attendance = require("../../Models/attendance");
const { normLanguage, normStage, isValidId, escapeRegex, isAll, normSection } = require("../../utils/normalize");
const { findBatchConflict, emptyBatchMap } = require("../../utils/batches");
const sa = require("../../utils/stageAccess");
const notify = require("../../utils/notify");

const MAX = 500;

const publicUser = (u) => {
  try {
    return require("./authController").toPublicUser(u);
  } catch (_) {
    return { _id: u._id, id: u._id, englishAccess: u.englishAccess, hindiAccess: u.hindiAccess };
  }
};

// GET /admin/promote/candidates
const promoteCandidates = async (req, res) => {
  try {
    const language = normLanguage(req.query.language) || "English";
    const stage = normStage(req.query.stage);
    if (!stage) return res.status(400).json({ message: "Choose a stage" });
    const f = sa.fields(language);

    const promotedView = String(req.query.view || "") === "promoted";
    const filter = promotedView
      ? { role: "student", isDropout: { $ne: true }, [`${f.done}.${stage}`]: true, [`${f.access}.${stage}`]: { $ne: true } }
      : { role: "student", isDropout: { $ne: true }, [`${f.access}.${stage}`]: true };
    const mode = String(req.query.mode || "").toLowerCase();
    if (mode === "online" || mode === "offline") filter.mode = mode;
    const section = String(req.query.section || "").trim();
    if (section && !isAll(section) && language === "English") filter.onlineSection = normSection(section);
    const q = String(req.query.q || "").trim();
    if (q) filter.$or = [{ name: new RegExp(escapeRegex(q), "i") }, { phone: new RegExp(escapeRegex(q)) }];

    const students = await User.find(filter)
      .select(`name phone mode onlineSection createdAt ${f.access} ${f.done} ${f.batch}`)
      .sort({ name: 1 })
      .limit(1000)
      .lean();

    // attendance in THIS stage → admin sees who is ready
    const ids = students.map((s) => s._id);
    const att = ids.length
      ? await Attendance.aggregate([
          { $match: { userId: { $in: ids }, language, stage } },
          {
            $group: {
              _id: "$userId",
              total: { $sum: 1 },
              came: { $sum: { $cond: [{ $in: ["$status", ["Present", "Late", "Partial"]] }, 1, 0] } },
              first: { $min: "$date" },
            },
          },
        ])
      : [];
    const byId = new Map(att.map((a) => [String(a._id), a]));

    // how many students are CURRENT in each stage → numbers on the stage buttons
    const base = { role: "student", isDropout: { $ne: true } };
    const [counts, promotedN, droppedN] = await Promise.all([
      Promise.all(sa.STAGES.map((st) => User.countDocuments({ ...base, [`${f.access}.${st}`]: true }))),
      User.countDocuments({ ...base, [`${f.done}.${stage}`]: true, [`${f.access}.${stage}`]: { $ne: true } }),
      User.countDocuments({ role: "student", isDropout: true, [`${f.done}.${stage}`]: true }),
    ]);
    const stageCounts = Object.fromEntries(sa.STAGES.map((st, i) => [st, counts[i]]));
    const summary = { left: stageCounts[stage], promoted: promotedN, dropped: droppedN };

    res.status(200).json({
      language,
      stage,
      stageCounts,
      summary,
      view: promotedView ? "promoted" : "left",
      next: sa.nextStage(stage), // null → stage 7: "Finish course"
      total: students.length,
      students: students.map((s) => {
        const a = byId.get(String(s._id)) || { total: 0, came: 0, first: null };
        const nowIn = sa.STAGES.filter((x) => sa.plain(s[f.access])[x]);
        const shownStage = promotedView ? nowIn[nowIn.length - 1] : stage; // promoted → timing of the stage they are in now
        return {
          _id: s._id,
          id: s._id,
          name: s.name,
          phone: s.phone,
          mode: s.mode,
          onlineSection: s.onlineSection,
          batch: (shownStage && s[f.batch] && s[f.batch][shownStage]) || "",
          nowIn, // promoted view: e.g. ["stage2"] ([] = course completed)
          classesInStage: a.total,
          attended: a.came,
          percent: a.total ? Math.round((a.came / a.total) * 100) : 0,
          inStageSince: a.first || null,
          // also current in a HIGHER stage → promoted the old way (both switched on) → tick and promote to fix
          alreadyIn: promotedView ? [] : sa.STAGES.filter((x) => x > stage && sa.plain(s[f.access])[x]),
        };
      }),
    });
  } catch (error) {
    console.error("Promote Candidates Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

/** Promote one user document (not saved). Returns { from, to } or { error }. */
const promoteOne = (user, language, wantedStage) => {
  const f = sa.fields(language);
  const access = sa.plain(user[f.access]);
  const done = sa.plain(user[f.done]);
  const from = wantedStage || sa.highestOn(access);
  if (!from || !access[from]) return { error: `${sa.label(language, wantedStage || "stage1")} is not this student's current stage` };
  const to = sa.nextStage(from);

  access[from] = false;
  done[from] = true;
  const batch = { ...emptyBatchMap(), ...(user[f.batch] ? JSON.parse(JSON.stringify(user[f.batch])) : {}) };
  if (to) {
    access[to] = true;
    done[to] = false;
    batch[to] = batch[to] || batch[from] || ""; // same class timing in the new stage
  }
  batch[from] = "";

  user[f.access] = access;
  user[f.done] = done;
  user[f.batch] = batch;
  return { from, to };
};

// POST /admin/promote
const promoteStudents = async (req, res) => {
  try {
    const language = normLanguage(req.body.language) || "English";
    const stage = req.body.stage ? normStage(req.body.stage) : null;
    if (req.body.stage && !stage) return res.status(400).json({ message: "Invalid stage" });
    const raw = Array.isArray(req.body.userIds) ? req.body.userIds : req.body.userId ? [req.body.userId] : [];
    const ids = [...new Set(raw.map(String))].filter(isValidId);
    if (!ids.length) return res.status(400).json({ message: "Choose at least one student" });
    if (ids.length > MAX) return res.status(400).json({ message: `At most ${MAX} students at once` });

    const users = await User.find({ _id: { $in: ids.map((i) => new mongoose.Types.ObjectId(i)) }, role: "student" });
    const promoted = [];
    const skipped = [];

    for (const user of users) {
      if (user.isDropout) {
        skipped.push({ id: String(user._id), name: user.name, reason: "Dropout — rejoin first" });
        continue;
      }
      const r = promoteOne(user, language, stage);
      if (r.error) {
        skipped.push({ id: String(user._id), name: user.name, reason: r.error });
        continue;
      }
      const clash = findBatchConflict(user);
      if (clash) {
        skipped.push({ id: String(user._id), name: user.name, reason: clash });
        continue;
      }
      await user.save();
      promoted.push({ id: String(user._id), name: user.name, from: r.from, to: r.to });

      if (req.io) {
        req.io.to(String(user._id)).emit("permissions_updated", {
          englishAccess: user.englishAccess,
          hindiAccess: user.hindiAccess,
          englishDone: user.englishDone,
          hindiDone: user.hindiDone,
          englishBatch: user.englishBatch,
          hindiBatch: user.hindiBatch,
          promoted: { language, from: r.from, to: r.to },
        });
        req.io.to("admin_room").emit("student_update", { userId: String(user._id), by: "admin", user: publicUser(user) });
      }
      if (r.to) notify.stageUnlocked(user._id, language, [Number(r.to.replace("stage", ""))]);
      else notify.courseFinished(user._id, language);
    }
    for (const id of ids) {
      if (!users.some((u) => String(u._id) === id)) skipped.push({ id, name: "", reason: "Student not found" });
    }

    const to = promoted[0] && promoted[0].to;
    const where = stage ? (to ? `${sa.label(language, stage)} → ${sa.label(language, to)}` : `${sa.label(language, stage)} finished`) : language;
    res.status(200).json({
      message: promoted.length
        ? `${promoted.length} student${promoted.length === 1 ? "" : "s"} promoted (${where})${skipped.length ? ` · ${skipped.length} skipped` : ""}`
        : "Nobody was promoted",
      promoted,
      skipped,
    });
  } catch (error) {
    console.error("Promote Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { promoteCandidates, promoteStudents, _internal: { promoteOne } };
