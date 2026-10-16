const Test = require("../../Models/test");
const Result = require("../../Models/result");
const User = require("../../Models/users");
const { normStage, stageVariants, normLanguage, isAll, isValidId, STAFF_ROLES } = require("../../utils/normalize");

const testFilter = (language, stage) => ({ language, stage: { $in: stageVariants(stage) } });

// Students must NEVER receive correctOptionIndex
const publicQuestions = (questions) =>
  (questions || []).map((q) => ({ _id: q._id, questionText: q.questionText, options: q.options }));

const withCreatedAt = (r) => ({ ...r, createdAt: r.createdAt || r.completedAt });

// =====================================================
// ADMIN: create / update / delete test
// =====================================================
const updateTest = async (req, res) => {
  try {
    const language = normLanguage(req.body.language);
    const stage = normStage(req.body.stage);
    const { isActive, questions, durationMinutes } = req.body;

    if (!language || !stage || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ message: "Missing required test fields" });
    }

    for (const [i, q] of questions.entries()) {
      const ok =
        q &&
        String(q.questionText || "").trim() &&
        Array.isArray(q.options) &&
        q.options.length >= 2 &&
        Number.isInteger(q.correctOptionIndex) &&
        q.correctOptionIndex >= 0 &&
        q.correctOptionIndex < q.options.length;
      if (!ok) return res.status(400).json({ message: `Question ${i + 1} is invalid` });
    }

    const test = await Test.findOneAndUpdate(
      testFilter(language, stage),
      {
        language,
        stage,
        isActive: isActive !== undefined ? !!isActive : true,
        questions,
        durationMinutes: Math.min(Math.max(Number(durationMinutes) || 25, 5), 180),
      },
      { upsert: true, new: true }
    );

    res.status(200).json({ message: "Test published successfully", test });
  } catch (error) {
    console.error("Update Test Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const deleteTest = async (req, res) => {
  try {
    const language = normLanguage(req.body.language || req.query.language);
    const stage = normStage(req.body.stage || req.query.stage);
    if (!language || !stage) return res.status(400).json({ message: "language and stage required" });

    await Test.findOneAndDelete(testFilter(language, stage));
    res.status(200).json({ message: "Test deleted successfully" });
  } catch (error) {
    console.error("Delete Test Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const getResults = async (req, res) => {
  try {
    const query = {};
    const language = normLanguage(req.query.language);
    const stage = normStage(req.query.stage);
    if (!isAll(req.query.language) && language) query.language = language;
    if (!isAll(req.query.stage) && stage) query.stage = { $in: stageVariants(stage) };

    const results = await Result.find(query).sort({ completedAt: -1 }).limit(2000).lean();
    res.status(200).json(results.map(withCreatedAt));
  } catch (error) {
    console.error("Get Admin Results Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// STUDENT: get test (answers stripped) / submit / my results
// =====================================================
const getTest = async (req, res) => {
  try {
    const language = normLanguage(req.query.language);
    const stage = normStage(req.query.stage);
    const userId = req.user ? String(req.user._id) : req.query.userId;
    if (!language || !stage) return res.status(400).json({ message: "language and stage required" });

    if (isValidId(userId)) {
      const existing = await Result.findOne({ userId, ...testFilter(language, stage) }).lean();
      if (existing) {
        return res.status(200).json({ completed: true, score: existing.score, total: existing.totalQuestions });
      }
    }

    const test = await Test.findOne({ ...testFilter(language, stage), isActive: true }).lean();
    if (!test) return res.status(404).json({ message: "No active test found" });

    res.status(200).json({
      completed: false,
      durationMinutes: test.durationMinutes || 25,
      questions: publicQuestions(test.questions),
    });
  } catch (error) {
    console.error("Get User Test Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const submitTest = async (req, res) => {
  try {
    const userId = req.user ? String(req.user._id) : req.body.userId;
    const language = normLanguage(req.body.language);
    const stage = normStage(req.body.stage);
    const answers = Array.isArray(req.body.answers) ? req.body.answers : [];

    if (!isValidId(userId) || !language || !stage) {
      return res.status(400).json({ message: "userId, language and stage required" });
    }

    const [user, test, existing] = await Promise.all([
      User.findById(userId).select("name phone mode").lean(),
      Test.findOne({ ...testFilter(language, stage), isActive: true }),
      Result.findOne({ userId, ...testFilter(language, stage) }).lean(),
    ]);

    if (!user) return res.status(404).json({ message: "User not found" });
    if (!test) return res.status(404).json({ message: "Test not found" });

    // One attempt per test — second submit returns the first score
    if (existing) {
      return res.status(200).json({
        message: "Test already submitted",
        alreadySubmitted: true,
        score: existing.score,
        total: existing.totalQuestions,
        result: withCreatedAt(existing),
      });
    }

    const seen = new Set();
    const cleanAnswers = [];
    let score = 0;
    for (const ans of answers) {
      const qid = String(ans && ans.questionId);
      if (seen.has(qid)) continue; // the same question can't be scored twice
      seen.add(qid);
      const q = test.questions.id(qid);
      const selectedIndex = Number(ans.selectedIndex);
      cleanAnswers.push({ questionId: qid, selectedIndex });
      if (q && q.correctOptionIndex === selectedIndex) score++;
    }

    const result = await Result.create({
      userId,
      userName: user.name,
      userPhone: user.phone,
      userMode: user.mode || "offline",
      language,
      stage,
      score,
      totalQuestions: test.questions.length,
      answers: cleanAnswers,
    });

    res.status(200).json({
      message: "Test submitted successfully",
      score,
      total: test.questions.length,
      result: withCreatedAt(result.toObject()),
      // Correct answers are only revealed AFTER the single attempt is saved
      review: test.questions.map((q) => ({ questionId: String(q._id), correctOptionIndex: q.correctOptionIndex })),
    });
  } catch (error) {
    console.error("Submit Test Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const getMyTestResults = async (req, res) => {
  try {
    // Students see only their own results; staff (admin panel) may pass ?userId= to view a student
    const isStaffUser = req.user && STAFF_ROLES.includes(req.user.role);
    const userId = req.user && !(isStaffUser && req.query.userId) ? String(req.user._id) : req.query.userId;
    if (!isValidId(userId)) return res.status(400).json({ message: "User ID is required" });

    const query = { userId };
    const language = normLanguage(req.query.language);
    if (!isAll(req.query.language) && language) query.language = language;

    const results = await Result.find(query).sort({ completedAt: -1 }).lean();
    res.status(200).json({ total: results.length, results: results.map(withCreatedAt) });
  } catch (error) {
    console.error("Get My Test Results Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { updateTest, deleteTest, getResults, getTest, submitTest, getMyTestResults };
