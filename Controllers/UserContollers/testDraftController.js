// =====================================================
// ✍️ TRAINER WRITES A TEST → ADMIN APPROVES → ADMIN RELEASES
//
// Trainer app
//   POST   /api/trainer/test-draft        { id?, title, language, stage, durationMinutes, questions }
//          new draft, or edit own draft (only while pending / rejected) → status "pending"
//   GET    /api/trainer/test-drafts       my drafts (newest first)
//   DELETE /api/trainer/test-draft?id=    delete my draft (not after release)
//
// Admin app
//   GET    /api/admin/test-drafts?status=pending|approved|rejected|released|all&language=&stage=
//   GET    /api/admin/test-draft?id=      one draft with all questions
//   POST   /api/admin/test-draft/review   { id, action: "approve" | "reject" | "release", note, questions?, durationMinutes? }
//          release = becomes the LIVE test of that language + stage (replaces the old one,
//          old results stay saved). Admin may fix questions before releasing.
// =====================================================
const TestDraft = require("../../Models/testDraft");
const { publishTest, checkQuestions, cleanQuestions, clampDuration } = require("./testController");
const { normLanguage, normStage, isValidId, isAll } = require("../../utils/normalize");

const adminsRoom = (req, event, payload) => {
  if (req.io) req.io.to("admin_room").emit(event, payload);
};
const tellTrainer = (req, draft) => {
  if (req.io) {
    req.io.to(String(draft.createdBy)).emit("test_draft_updated", {
      id: String(draft._id),
      status: draft.status,
      note: draft.reviewNote || "",
    });
  }
};

const summary = (d) => ({
  _id: d._id,
  title: d.title,
  language: d.language,
  stage: d.stage,
  durationMinutes: d.durationMinutes,
  questionCount: (d.questions || []).length,
  status: d.status,
  createdBy: d.createdBy,
  createdByName: d.createdByName,
  reviewNote: d.reviewNote,
  reviewedByName: d.reviewedByName,
  reviewedAt: d.reviewedAt,
  releasedAt: d.releasedAt,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

// ---------------- TRAINER ----------------
const saveDraft = async (req, res) => {
  try {
    // A trainer writes tests only for THEIR class (their language + stage).
    // Admin / manager may write for any class.
    const isTrainer = req.user && req.user.role === "teacher";
    const language = isTrainer ? normLanguage(req.user.language || "English") : normLanguage(req.body.language);
    const stage = isTrainer ? normStage(req.user.teacherStage || "stage1") : normStage(req.body.stage);
    const { id, title, durationMinutes, questions } = req.body;
    if (!language || !stage) return res.status(400).json({ message: "Choose language and stage" });
    const bad = checkQuestions(questions, { strict: true });
    if (bad) return res.status(400).json({ message: bad });

    const data = {
      title: String(title || "").slice(0, 120),
      language,
      stage,
      durationMinutes: clampDuration(durationMinutes),
      questions: cleanQuestions(questions),
      status: "pending",
      reviewNote: "",
      reviewedBy: null,
      reviewedByName: "",
      reviewedAt: null,
    };

    let draft;
    if (id) {
      if (!isValidId(id)) return res.status(400).json({ message: "Invalid id" });
      draft = await TestDraft.findOne({ _id: id, createdBy: req.user._id });
      if (!draft) return res.status(404).json({ message: "Test not found" });
      if (!["pending", "rejected"].includes(draft.status)) {
        return res.status(409).json({ message: "This test is already approved. Make a new one to change it." });
      }
      Object.assign(draft, data);
      await draft.save();
    } else {
      const open = await TestDraft.countDocuments({ createdBy: req.user._id, status: "pending" });
      if (open >= 20) return res.status(429).json({ message: "You already have 20 tests waiting for the admin" });
      draft = await TestDraft.create({ ...data, createdBy: req.user._id, createdByName: req.user.name || "" });
    }

    adminsRoom(req, "test_draft_new", summary(draft));
    res.status(200).json({ message: "Sent to admin for approval ✅", draft });
  } catch (error) {
    console.error("Save Test Draft Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const myDrafts = async (req, res) => {
  try {
    const drafts = await TestDraft.find({ createdBy: req.user._id }).sort({ updatedAt: -1 }).limit(200).lean();
    res.status(200).json({ drafts });
  } catch (error) {
    console.error("My Test Drafts Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const deleteMyDraft = async (req, res) => {
  try {
    const id = req.query.id || req.body.id;
    if (!isValidId(id)) return res.status(400).json({ message: "Invalid id" });
    const d = await TestDraft.findOne({ _id: id, createdBy: req.user._id });
    if (!d) return res.status(404).json({ message: "Test not found" });
    if (d.status === "released") return res.status(409).json({ message: "Released tests can only be removed by the admin" });
    await d.deleteOne();
    res.status(200).json({ message: "Deleted" });
  } catch (error) {
    console.error("Delete Test Draft Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// ---------------- ADMIN ----------------
const listDrafts = async (req, res) => {
  try {
    const status = String(req.query.status || "pending").toLowerCase();
    const filter = {};
    if (status !== "all") filter.status = status;
    const language = isAll(req.query.language) ? null : normLanguage(req.query.language);
    const stage = isAll(req.query.stage) ? null : normStage(req.query.stage);
    if (language) filter.language = language;
    if (stage) filter.stage = stage;

    const [drafts, counts] = await Promise.all([
      TestDraft.find(filter).sort({ updatedAt: -1 }).limit(300).lean(),
      TestDraft.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);
    const byStatus = { pending: 0, approved: 0, rejected: 0, released: 0 };
    for (const c of counts) byStatus[c._id] = c.n;
    res.status(200).json({ counts: byStatus, drafts: drafts.map(summary) });
  } catch (error) {
    console.error("List Test Drafts Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const getDraft = async (req, res) => {
  try {
    if (!isValidId(req.query.id)) return res.status(400).json({ message: "Invalid id" });
    const draft = await TestDraft.findById(req.query.id).lean();
    if (!draft) return res.status(404).json({ message: "Test not found" });
    res.status(200).json({ draft });
  } catch (error) {
    console.error("Get Test Draft Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const reviewDraft = async (req, res) => {
  try {
    const { id, action, note } = req.body;
    if (!isValidId(id)) return res.status(400).json({ message: "Invalid id" });
    if (!["approve", "reject", "release"].includes(action)) {
      return res.status(400).json({ message: "action must be approve, reject or release" });
    }
    const draft = await TestDraft.findById(id);
    if (!draft) return res.status(404).json({ message: "Test not found" });

    // admin fixed some questions / time before deciding
    if (Array.isArray(req.body.questions)) {
      const bad = checkQuestions(req.body.questions, { strict: true });
      if (bad) return res.status(400).json({ message: bad });
      draft.questions = cleanQuestions(req.body.questions);
    }
    if (req.body.durationMinutes !== undefined) draft.durationMinutes = clampDuration(req.body.durationMinutes);

    draft.reviewNote = String(note || "").slice(0, 500);
    draft.reviewedBy = req.user._id;
    draft.reviewedByName = req.user.name || "";
    draft.reviewedAt = new Date();

    let message;
    if (action === "reject") {
      if (draft.status === "released") return res.status(409).json({ message: "Already released" });
      draft.status = "rejected";
      message = "Sent back to the trainer";
    } else if (action === "approve") {
      if (draft.status === "released") return res.status(409).json({ message: "Already released" });
      draft.status = "approved";
      message = "Approved — press Release when students should see it";
    } else {
      await publishTest(req, {
        language: draft.language,
        stage: draft.stage,
        questions: draft.questions.map((q) => ({
          questionText: q.questionText,
          options: q.options,
          correctOptionIndex: q.correctOptionIndex,
        })),
        durationMinutes: draft.durationMinutes,
        isActive: true,
      });
      draft.status = "released";
      draft.releasedAt = new Date();
      message = `Released ✅ ${draft.language} ${draft.stage.replace("stage", "Stage ")} students can take it now`;
    }
    await draft.save();

    tellTrainer(req, draft);
    adminsRoom(req, "test_draft_updated", summary(draft));
    res.status(200).json({ message, draft });
  } catch (error) {
    console.error("Review Test Draft Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { saveDraft, myDrafts, deleteMyDraft, listDrafts, getDraft, reviewDraft };