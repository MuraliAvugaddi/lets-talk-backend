const Test = require("../../Models/test");
const Result = require("../../Models/result");
const User = require("../../Models/users");
const TestStart = require("../../Models/testStart");
const { normStage, stageVariants, normLanguage, isAll, isValidId, STAFF_ROLES } = require("../../utils/normalize");

const STAGES = ["stage1", "stage2", "stage3", "stage4", "stage5", "stage6", "stage7"];

const testFilter = (language, stage) => ({ language, stage: { $in: stageVariants(stage) } });

// Students must NEVER receive correctOptionIndex before submitting
const publicQuestions = (questions) =>
  (questions || []).map((q) => ({ _id: q._id, questionText: q.questionText, options: q.options }));

const withCreatedAt = (r) => ({ ...r, createdAt: r.createdAt || r.completedAt });

// Version of a published test = publish time in ms (older tests: creation time)
const versionOf = (test) => {
  const d = test && (test.publishedAt || test.createdAt || test.updatedAt);
  return d ? new Date(d).getTime() : 0;
};

// Did this student already finish THIS version of the test?
// Results saved before versions existed count if they were made after the test was published.
const resultForVersion = (userId, language, stage, test) => {
  const v = versionOf(test);
  return Result.findOne({
    userId,
    ...testFilter(language, stage),
    $or: [{ testVersion: v }, { testVersion: { $in: [0, null] }, completedAt: { $gte: new Date(v) } }],
  })
    .sort({ completedAt: -1 })
    .lean();
};

// ⚡ Tell every student app that a test changed (published / paused / deleted) → lists refresh by themselves
const announce = (req, language, stage, action) => {
  if (req.io) req.io.emit("test_updated", { language, stage, action, at: Date.now() });
};

// Seconds left for a started attempt (null = not started)
const secondsLeftFor = (start, test) => {
  if (!start) return null;
  const end = new Date(start.startedAt).getTime() + (test.durationMinutes || 25) * 60000;
  return Math.max(0, Math.round((end - Date.now()) / 1000));
};

// Questions + the student's answers + correct answers (only AFTER the attempt is saved)
const reviewPayload = (test, result) => {
  if (!test || !result) return {};
  return {
    questions: (test.questions || []).map((q) => ({
      _id: String(q._id),
      questionText: q.questionText,
      options: q.options,
      correctOptionIndex: q.correctOptionIndex,
    })),
    answers: result.answers || [],
    review: (test.questions || []).map((q) => ({ questionId: String(q._id), correctOptionIndex: q.correctOptionIndex })),
  };
};

// =====================================================
// ADMIN: publish / view / pause / delete test
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
        publishedAt: new Date(), // new version → everyone can take it; old results stay saved
      },
      { upsert: true, returnDocument: "after" }
    );

    announce(req, language, stage, "published");
    res.status(200).json({ message: "Test published successfully", test });
  } catch (error) {
    console.error("Update Test Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// GET /admin/get-test?language=&stage=  → the live test with answers + how many submitted
const getAdminTest = async (req, res) => {
  try {
    const language = normLanguage(req.query.language);
    const stage = normStage(req.query.stage);
    if (!language || !stage) return res.status(400).json({ message: "language and stage required" });

    const test = await Test.findOne(testFilter(language, stage)).lean();
    const totalResults = await Result.countDocuments(testFilter(language, stage));
    if (!test) return res.status(200).json({ exists: false, totalResults });

    const v = versionOf(test);
    const submissions = await Result.countDocuments({
      ...testFilter(language, stage),
      $or: [{ testVersion: v }, { testVersion: { $in: [0, null] }, completedAt: { $gte: new Date(v) } }],
    });
    res.status(200).json({
      exists: true,
      isActive: !!test.isActive,
      durationMinutes: test.durationMinutes || 25,
      publishedAt: test.publishedAt || test.createdAt,
      questions: test.questions || [],
      submissions,
      totalResults,
    });
  } catch (error) {
    console.error("Get Admin Test Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// POST /admin/test-active { language, stage, isActive }  → pause / resume without deleting
const setTestActive = async (req, res) => {
  try {
    const language = normLanguage(req.body.language);
    const stage = normStage(req.body.stage);
    if (!language || !stage) return res.status(400).json({ message: "language and stage required" });
    const test = await Test.findOneAndUpdate(
      testFilter(language, stage),
      { $set: { isActive: req.body.isActive === true } },
      { returnDocument: "after" }
    );
    if (!test) return res.status(404).json({ message: "No test for this stage" });
    announce(req, language, stage, test.isActive ? "resumed" : "paused");
    res.status(200).json({ message: test.isActive ? "Test is live for students" : "Test paused", isActive: test.isActive });
  } catch (error) {
    console.error("Set Test Active Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// Deletes ONLY the test. Student results are always kept.
const deleteTest = async (req, res) => {
  try {
    const language = normLanguage(req.body.language || req.query.language);
    const stage = normStage(req.body.stage || req.query.stage);
    if (!language || !stage) return res.status(400).json({ message: "language and stage required" });

    const deleted = await Test.findOneAndDelete(testFilter(language, stage));
    const kept = await Result.countDocuments(testFilter(language, stage));
    if (deleted) announce(req, language, stage, "deleted");
    res.status(200).json({
      message: deleted ? "Test deleted. Student results are kept." : "No test for this stage",
      deleted: !!deleted,
      resultsKept: kept,
    });
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
// STUDENT: overview / get test (answers stripped) / submit / my results
// =====================================================

// GET /user/test-overview?language=English → status of all 7 stages in ONE call
const getTestOverview = async (req, res) => {
  try {
    const language = normLanguage(req.query.language) || "English";
    const userId = req.user ? String(req.user._id) : req.query.userId;

    const tests = await Test.find({ language }).select("stage isActive durationMinutes questions._id publishedAt createdAt").lean();
    const results = isValidId(userId)
      ? await Result.find({ userId, language }).sort({ completedAt: -1 }).lean()
      : [];

    const stages = STAGES.map((stage) => {
      const variants = stageVariants(stage);
      const test = tests.find((t) => variants.includes(t.stage));
      const mine = results.filter((r) => variants.includes(r.stage));
      const v = versionOf(test);
      const current = test
        ? mine.find((r) => r.testVersion === v || (!r.testVersion && new Date(r.completedAt).getTime() >= v))
        : null;
      const last = mine[0] || null;
      return {
        stage,
        available: !!(test && test.isActive && (test.questions || []).length),
        questions: test ? (test.questions || []).length : 0,
        durationMinutes: test ? test.durationMinutes || 25 : 25,
        completed: !!current,
        score: current ? current.score : null,
        total: current ? current.totalQuestions : null,
        lastScore: last ? last.score : null,
        lastTotal: last ? last.totalQuestions : null,
        attempts: mine.length,
      };
    });
    res.status(200).json({ language, stages });
  } catch (error) {
    console.error("Test Overview Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const getTest = async (req, res) => {
  try {
    const language = normLanguage(req.query.language);
    const stage = normStage(req.query.stage);
    const userId = req.user ? String(req.user._id) : req.query.userId;
    if (!language || !stage) return res.status(400).json({ message: "language and stage required" });

    const test = await Test.findOne(testFilter(language, stage)).lean();

    if (isValidId(userId) && test) {
      const existing = await resultForVersion(userId, language, stage, test);
      if (existing) {
        return res.status(200).json({
          completed: true,
          score: existing.score,
          total: existing.totalQuestions,
          completedAt: existing.completedAt,
          ...reviewPayload(test, existing), // review works on any phone, any time
        });
      }
    }

    if (!test || !test.isActive || !(test.questions || []).length) {
      // No live test now — still show the last result if the student has one
      if (isValidId(userId)) {
        const last = await Result.findOne({ userId, ...testFilter(language, stage) }).sort({ completedAt: -1 }).lean();
        if (last) {
          return res.status(200).json({
            completed: true,
            score: last.score,
            total: last.totalQuestions,
            completedAt: last.completedAt,
            answers: last.answers || [],
          });
        }
      }
      return res.status(404).json({ message: "No active test found" });
    }

    // Already pressed Start earlier? → continue with the time that is LEFT (server clock)
    let secondsLeft = null;
    if (isValidId(userId)) {
      const start = await TestStart.findOne({ userId, language, stage, testVersion: versionOf(test) }).lean();
      secondsLeft = secondsLeftFor(start, test);
    }

    res.status(200).json({
      completed: false,
      durationMinutes: test.durationMinutes || 25,
      questions: publicQuestions(test.questions),
      started: secondsLeft !== null,
      secondsLeft, // null = not started yet
    });
  } catch (error) {
    console.error("Get User Test Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// POST /user/start-test { language, stage } → starts the countdown (once per test version)
const startTest = async (req, res) => {
  try {
    const userId = req.user ? String(req.user._id) : req.body.userId;
    const language = normLanguage(req.body.language);
    const stage = normStage(req.body.stage);
    if (!isValidId(userId) || !language || !stage) {
      return res.status(400).json({ message: "userId, language and stage required" });
    }
    const test = await Test.findOne({ ...testFilter(language, stage), isActive: true }).lean();
    if (!test) return res.status(404).json({ message: "Test not found" });

    const testVersion = versionOf(test);
    // upsert: pressing Start again never resets the clock
    const start = await TestStart.findOneAndUpdate(
      { userId, language, stage, testVersion },
      { $setOnInsert: { userId, language, stage, testVersion, startedAt: new Date() } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    ).lean();
    res.status(200).json({
      startedAt: start.startedAt,
      durationMinutes: test.durationMinutes || 25,
      secondsLeft: secondsLeftFor(start, test),
    });
  } catch (error) {
    console.error("Start Test Error:", error);
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

    const [user, test] = await Promise.all([
      User.findById(userId).select("name phone mode").lean(),
      Test.findOne({ ...testFilter(language, stage), isActive: true }),
    ]);

    if (!user) return res.status(404).json({ message: "User not found" });
    if (!test) return res.status(404).json({ message: "Test not found" });

    // One attempt per published version — a second submit returns the first score
    const existing = await resultForVersion(userId, language, stage, test);
    if (existing) {
      return res.status(200).json({
        message: "Test already submitted",
        alreadySubmitted: true,
        score: existing.score,
        total: existing.totalQuestions,
        result: withCreatedAt(existing),
        ...reviewPayload(test, existing),
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
      testVersion: versionOf(test),
    });

    res.status(200).json({
      message: "Test submitted successfully",
      score,
      total: test.questions.length,
      result: withCreatedAt(result.toObject()),
      // Correct answers are only revealed AFTER the single attempt is saved
      ...reviewPayload(test, result.toObject()),
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

module.exports = {
  updateTest,
  getAdminTest,
  setTestActive,
  deleteTest,
  getResults,
  getTestOverview,
  getTest,
  startTest,
  submitTest,
  getMyTestResults,
  _internal: { versionOf, secondsLeftFor },
};
