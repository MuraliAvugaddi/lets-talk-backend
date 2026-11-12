// =====================================================
// 🚪 DROPOUTS — students who stopped the course in the middle
//
//   POST /api/admin/dropout           { userId, language, stage, reason, reasonType }
//        → all access OFF, student saved in the dropout list (with a reason)
//   POST /api/admin/dropout/rejoin    { id }           → access given back exactly as before
//   POST /api/admin/dropout/note      { id, text }     → principal's call note
//   GET  /api/admin/dropouts?status=dropped|rejoined|all&language=&stage=&mode=&section=&q=
//   GET  /api/admin/dropout?id=       → one dropout with fees, attendance, practice, tests
// =====================================================
const mongoose = require("mongoose");
const User = require("../../Models/users");
const Dropout = require("../../Models/dropout");
const Attendance = require("../../Models/attendance");
const Practice = require("../../Models/practice");
const Result = require("../../Models/result");
const { normLanguage, normStage, isValidId, escapeRegex, isAll } = require("../../utils/normalize");

const STAGES = ["stage1", "stage2", "stage3", "stage4", "stage5", "stage6", "stage7"];
const allOff = () => Object.fromEntries(STAGES.map((s) => [s, false]));
const plain = (access) => Object.fromEntries(STAGES.map((s) => [s, !!(access && access[s])]));

/** Unpaid months up to this month (0 when paid). Never paid → counted from the joining month. */
const monthsPending = (user, now = new Date()) => {
  if (!user || user.feeStatus === "paid") return 0;
  const from = user.lastFeePaymentDate
    ? new Date(user.lastFeePaymentDate.getFullYear(), user.lastFeePaymentDate.getMonth() + 1, 1)
    : new Date((user.createdAt || now).getFullYear(), (user.createdAt || now).getMonth(), 1);
  const months = (now.getFullYear() - from.getFullYear()) * 12 + (now.getMonth() - from.getMonth()) + 1;
  return Math.max(months, 1);
};

const tellEveryone = (req, user) => {
  if (!req.io) return;
  req.io.to(String(user._id)).emit("permissions_updated", {
    englishAccess: user.englishAccess,
    hindiAccess: user.hindiAccess,
    isDropout: user.isDropout,
  });
  req.io.to("admin_room").emit("student_update", {
    userId: String(user._id),
    by: "admin",
    user: {
      _id: user._id,
      id: user._id,
      englishAccess: user.englishAccess,
      hindiAccess: user.hindiAccess,
      isDropout: user.isDropout,
      droppedAt: user.droppedAt,
    },
  });
  req.io.to("admin_room").emit("dropout_update", { userId: String(user._id), isDropout: user.isDropout });
};

// POST /admin/dropout
const markDropout = async (req, res) => {
  try {
    const { userId, reasonType } = req.body;
    const language = normLanguage(req.body.language);
    const stage = normStage(req.body.stage);
    const reason = String(req.body.reason || "").trim();
    if (!isValidId(userId)) return res.status(400).json({ message: "Valid userId required" });
    if (!language || !stage) return res.status(400).json({ message: "Choose the language and stage the student stopped" });
    if (reason.length < 3) return res.status(400).json({ message: "Write the reason (at least 3 letters)" });

    const user = await User.findById(userId);
    if (!user || user.role !== "student") return res.status(404).json({ message: "Student not found" });
    if (user.isDropout) return res.status(409).json({ message: "This student is already marked as dropout" });

    const drop = await Dropout.create({
      userId: user._id,
      name: user.name,
      phone: user.phone,
      mode: user.mode,
      onlineSection: user.onlineSection,
      batchTime: user.batchTime,
      joinedAt: user.createdAt,
      language,
      stage,
      reason: reason.slice(0, 500),
      reasonType: String(reasonType || "").slice(0, 40),
      englishAccess: plain(user.englishAccess),
      hindiAccess: plain(user.hindiAccess),
      feeStatus: user.feeStatus,
      lastFeePaymentDate: user.lastFeePaymentDate,
      monthsPending: monthsPending(user),
      droppedBy: req.user ? req.user._id : null,
      droppedByName: req.user ? req.user.name || "" : "",
    });

    // 🔒 all access off
    user.englishAccess = allOff();
    user.hindiAccess = allOff();
    user.isDropout = true;
    user.droppedAt = new Date();
    await user.save();
    tellEveryone(req, user);

    res.status(200).json({ message: `${user.name} marked as dropout. All access is off.`, dropout: drop });
  } catch (error) {
    console.error("Mark Dropout Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// POST /admin/dropout/rejoin
const rejoinDropout = async (req, res) => {
  try {
    const { id } = req.body;
    if (!isValidId(id)) return res.status(400).json({ message: "Invalid id" });
    const drop = await Dropout.findById(id);
    if (!drop) return res.status(404).json({ message: "Not found" });
    if (drop.status === "rejoined") return res.status(409).json({ message: "Already rejoined" });

    const user = await User.findById(drop.userId);
    if (!user) return res.status(404).json({ message: "Student account was deleted" });

    user.englishAccess = plain(drop.englishAccess);
    user.hindiAccess = plain(drop.hindiAccess);
    user.isDropout = false;
    user.droppedAt = null;
    await user.save();

    drop.status = "rejoined";
    drop.rejoinedAt = new Date();
    drop.rejoinedByName = req.user ? req.user.name || "" : "";
    await drop.save();
    tellEveryone(req, user);

    res.status(200).json({ message: `Welcome back! ${user.name}'s access is on again.`, dropout: drop });
  } catch (error) {
    console.error("Rejoin Dropout Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// POST /admin/dropout/note
const addDropoutNote = async (req, res) => {
  try {
    const { id } = req.body;
    const text = String(req.body.text || "").trim();
    if (!isValidId(id)) return res.status(400).json({ message: "Invalid id" });
    if (!text) return res.status(400).json({ message: "Write a note" });
    const drop = await Dropout.findByIdAndUpdate(
      id,
      {
        $push: {
          notes: { text: text.slice(0, 1000), by: req.user ? req.user._id : null, byName: req.user ? req.user.name || "" : "" },
        },
      },
      { returnDocument: "after" }
    );
    if (!drop) return res.status(404).json({ message: "Not found" });
    if (req.io) req.io.to("admin_room").emit("dropout_update", { userId: String(drop.userId || ""), note: true });
    res.status(200).json({ message: "Note saved", notes: drop.notes });
  } catch (error) {
    console.error("Dropout Note Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// GET /admin/dropouts
const listDropouts = async (req, res) => {
  try {
    const status = String(req.query.status || "dropped").toLowerCase();
    const filter = {};
    if (status !== "all") filter.status = status === "rejoined" ? "rejoined" : "dropped";
    const language = isAll(req.query.language) ? null : normLanguage(req.query.language);
    const stage = isAll(req.query.stage) ? null : normStage(req.query.stage);
    if (language) filter.language = language;
    if (stage) filter.stage = stage;
    const mode = String(req.query.mode || "").toLowerCase();
    if (mode === "online" || mode === "offline") filter.mode = mode;
    const section = String(req.query.section || "").trim();
    if (section && !isAll(section)) filter.onlineSection = section.toUpperCase();
    const q = String(req.query.q || "").trim();
    if (q) filter.$or = [{ name: new RegExp(escapeRegex(q), "i") }, { phone: new RegExp(escapeRegex(q)) }];

    const [rows, counts] = await Promise.all([
      Dropout.find(filter).sort({ createdAt: -1 }).limit(500).lean(),
      Dropout.aggregate([
        { $match: { status: "dropped" } },
        { $group: { _id: { language: "$language", stage: "$stage" }, n: { $sum: 1 } } },
      ]),
    ]);

    // live fee status (the student may have paid later)
    const users = await User.find({ _id: { $in: rows.map((r) => r.userId) } })
      .select("feeStatus lastFeePaymentDate createdAt")
      .lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    const list = rows.map((r) => {
      const u = byId.get(String(r.userId));
      return {
        ...r,
        notesCount: (r.notes || []).length,
        lastNote: (r.notes || []).length ? r.notes[r.notes.length - 1] : null,
        notes: undefined,
        feeNow: u ? { feeStatus: u.feeStatus, monthsPending: monthsPending(u), lastFeePaymentDate: u.lastFeePaymentDate } : null,
      };
    });

    const summary = { total: 0, English: {}, Hindi: {} };
    for (const c of counts) {
      summary.total += c.n;
      summary[c._id.language] = summary[c._id.language] || {};
      summary[c._id.language][c._id.stage] = c.n;
    }

    res.status(200).json({ summary, dropouts: list });
  } catch (error) {
    console.error("List Dropouts Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// GET /admin/dropout?id=
const dropoutDetail = async (req, res) => {
  try {
    const { id } = req.query;
    if (!isValidId(id)) return res.status(400).json({ message: "Invalid id" });
    const drop = await Dropout.findById(id).lean();
    if (!drop) return res.status(404).json({ message: "Not found" });

    const uid = new mongoose.Types.ObjectId(String(drop.userId));
    const [user, att, lastSeen, practice, practiceNotes, results] = await Promise.all([
      User.findById(uid).select("name phone mode onlineSection batchTime feeStatus lastFeePaymentDate createdAt").lean(),
      Attendance.aggregate([
        { $match: { userId: uid } },
        { $group: { _id: { language: "$language", stage: "$stage", status: "$status" }, n: { $sum: 1 } } },
      ]),
      Attendance.findOne({ userId: uid, status: { $ne: "Absent" } })
        .sort({ createdAt: -1 })
        .select("date language stage status")
        .lean(),
      Practice.aggregate([
        { $match: { userId: uid } },
        {
          $group: {
            _id: { language: "$language", stage: "$stage" },
            n: { $sum: 1 },
            rated: { $sum: { $cond: [{ $gt: ["$rating", 0] }, 1, 0] } },
            ratingSum: { $sum: "$rating" },
          },
        },
      ]),
      Practice.find({ userId: uid, $or: [{ note: { $ne: "" } }, { rating: { $gt: 0 } }] })
        .sort({ practicedAt: -1 })
        .limit(5)
        .select("date language stage rating note tags trainerName")
        .lean(),
      Result.find({ userId: uid }).sort({ completedAt: -1 }).limit(30).select("language stage score totalQuestions completedAt").lean(),
    ]);

    // attendance per course
    const attendance = {};
    for (const a of att) {
      const key = `${a._id.language}|${a._id.stage}`;
      attendance[key] = attendance[key] || {
        language: a._id.language,
        stage: a._id.stage,
        Present: 0,
        Late: 0,
        Partial: 0,
        Absent: 0,
      };
      attendance[key][a._id.status] = (attendance[key][a._id.status] || 0) + a.n;
    }
    const attendanceList = Object.values(attendance).map((x) => {
      const total = x.Present + x.Late + x.Partial + x.Absent;
      const came = x.Present + x.Late + x.Partial;
      return { ...x, total, came, percent: total ? Math.round((came / total) * 100) : 0 };
    });

    const practiceList = practice.map((p) => ({
      language: p._id.language,
      stage: p._id.stage,
      count: p.n,
      avgRating: p.rated ? Math.round((p.ratingSum / p.rated) * 10) / 10 : 0,
    }));

    // tests: best + last per course
    const tests = {};
    for (const r of results) {
      const key = `${r.language}|${r.stage}`;
      if (!tests[key]) tests[key] = { language: r.language, stage: r.stage, attempts: 0, best: 0, last: null };
      const t = tests[key];
      t.attempts += 1;
      const pct = r.totalQuestions ? Math.round((r.score / r.totalQuestions) * 100) : 0;
      if (pct > t.best) t.best = pct;
      if (!t.last) t.last = { percent: pct, score: r.score, total: r.totalQuestions, at: r.completedAt };
    }

    const joined = (user && user.createdAt) || drop.joinedAt;
    const daysWithUs = joined
      ? Math.max(1, Math.round(((drop.createdAt ? new Date(drop.createdAt) : new Date()) - new Date(joined)) / 86400000))
      : 0;

    res.status(200).json({
      dropout: drop,
      student: user,
      joinedAt: joined,
      daysWithUs,
      fee: user
        ? { feeStatus: user.feeStatus, lastFeePaymentDate: user.lastFeePaymentDate, monthsPending: monthsPending(user) }
        : { feeStatus: drop.feeStatus, lastFeePaymentDate: drop.lastFeePaymentDate, monthsPending: drop.monthsPending },
      attendance: attendanceList,
      lastAttended: lastSeen,
      practice: practiceList,
      practiceNotes,
      tests: Object.values(tests),
    });
  } catch (error) {
    console.error("Dropout Detail Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = {
  markDropout,
  rejoinDropout,
  addDropoutNote,
  listDropouts,
  dropoutDetail,
  _internal: { monthsPending },
};
