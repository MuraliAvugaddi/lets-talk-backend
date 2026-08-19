const Test = require("../../Models/test");
const Result = require("../../Models/result");
const User = require("../../Models/users");

// --- 1. ADMIN: CREATE OR UPDATE TEST ---
const updateTest = async (req, res) => {
  try {
    const { language, stage, isActive, questions, durationMinutes } = req.body;

    if (!language || !stage || !questions) {
      return res.status(400).json({ message: "Missing required test fields" });
    }

    const test = await Test.findOneAndUpdate(
      { language, stage },
      {
        language,
        stage,
        isActive: isActive !== undefined ? isActive : true,
        questions,
        durationMinutes: durationMinutes || 25,
      },
      { upsert: true, new: true }
    );

    res.status(200).json({ message: "Test published successfully", test });
  } catch (error) {
    console.error("Update Test Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 2. ADMIN: DELETE ACTIVE TEST ---
const deleteTest = async (req, res) => {
  try {
    const { language, stage } = req.body;
    await Test.findOneAndDelete({ language, stage });
    res.status(200).json({ message: "Test deleted successfully" });
  } catch (error) {
    console.error("Delete Test Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 3. ADMIN: GET ALL STUDENT RESULTS ---
const getResults = async (req, res) => {
  try {
    const { language, stage } = req.query;
    let query = {};
    if (language) query.language = language;
    if (stage) query.stage = stage;

    const results = await Result.find(query).sort({ createdAt: -1 });
    res.status(200).json(results);
  } catch (error) {
    console.error("Get Admin Results Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 4. USER: GET TEST QUESTIONS ---
const getTest = async (req, res) => {
  try {
    const { language, stage, userId } = req.query;

    if (userId) {
      const existingResult = await Result.findOne({ userId, language, stage });
      if (existingResult) {
        return res.status(200).json({
          completed: true,
          score: existingResult.score,
          total: existingResult.totalQuestions,
        });
      }
    }

    const test = await Test.findOne({ language, stage, isActive: true });
    if (!test) {
      return res.status(404).json({ message: "No active test found" });
    }

    res.status(200).json({
      completed: false,
      durationMinutes: test.durationMinutes || 25,
      questions: test.questions,
    });
  } catch (error) {
    console.error("Get User Test Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 5. USER: SUBMIT ANSWERS ---
const submitTest = async (req, res) => {
  try {
    const { userId, userName, userPhone, userMode, language, stage, answers } =
      req.body;

    const test = await Test.findOne({ language, stage });
    if (!test) {
      return res.status(404).json({ message: "Test not found" });
    }

    let calculatedScore = 0;
    const totalQuestions = test.questions.length;

    answers.forEach((ans) => {
      const q = test.questions.id(ans.questionId);
      if (q && q.correctOptionIndex === ans.selectedIndex) {
        calculatedScore++;
      }
    });

    const result = await Result.create({
      userId,
      userName,
      userPhone,
      userMode: userMode || "offline",
      language,
      stage,
      score: calculatedScore,
      totalQuestions,
      answers,
    });

    res.status(200).json({
      message: "Test submitted successfully",
      score: calculatedScore,
      total: totalQuestions,
      result,
    });
  } catch (error) {
    console.error("Submit Test Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 6. USER: GET PERSONAL TEST RESULTS ---
const getMyTestResults = async (req, res) => {
  try {
    const { userId, language } = req.query;
    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    let query = { userId };
    if (language && language.toLowerCase() !== "all") {
      query.language = language;
    }

    const results = await Result.find(query).sort({ createdAt: -1 });

    res.status(200).json({
      total: results.length,
      results,
    });
  } catch (error) {
    console.error("Get My Test Results Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = {
  updateTest,
  deleteTest,
  getResults,
  getTest,
  submitTest,
  getMyTestResults,
};