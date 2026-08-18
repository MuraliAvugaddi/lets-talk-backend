const Test = require("../../Models/test");
const Result = require("../../Models/result");

// --- ADMIN: Create or Update a Test ---
const updateTest = async (req, res) => {
  try {
    const { language, stage, questions, isActive } = req.body;
    
    // Find existing test for this stage or create new
    let test = await Test.findOne({ language, stage });
    
    if (test) {
      test.questions = questions;
      test.isActive = isActive;
      await test.save();
    } else {
      test = await Test.create({ language, stage, questions, isActive });
    }
    
    res.status(200).json({ message: "Test updated successfully", test });
  } catch (error) {
    console.error("Update Test Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- USER: Get Test (Checks if already taken) ---
const getTest = async (req, res) => {
  try {
    const { language, stage, userId } = req.query; 
    
    const test = await Test.findOne({ language, stage });
    
    if (!test || !test.isActive) {
      return res.status(404).json({ message: "No test scheduled currently." });
    }

    // 1. CHECK IF USER ALREADY COMPLETED THIS TEST
    if (userId) {
      const existingResult = await Result.findOne({ userId, language, stage });
      if (existingResult) {
        return res.json({
          completed: true, 
          score: existingResult.score,
          total: existingResult.totalQuestions
        });
      }
    }
    
    // 2. If not taken, send questions (WITHOUT CORRECT ANSWERS)
    const safeQuestions = test.questions.map(q => ({
      _id: q._id,
      questionText: q.questionText,
      options: q.options
    }));

    res.json({ 
      completed: false, 
      ...test._doc, 
      questions: safeQuestions, 
      durationMinutes: test.durationMinutes 
    });

  } catch (error) {
    console.error("Get Test Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- USER: Submit Test & Calculate Score ---
const submitTest = async (req, res) => {
  try {
    // 1. Receive userPhone and other details
    const { userId, userName, userPhone, userMode, language, stage, answers } = req.body;
    
    // Validate User ID
    if (!userId) {
      return res.status(400).json({ message: "User ID is missing. Please re-login." });
    }

    const test = await Test.findOne({ language, stage });
    if (!test) {
      return res.status(404).json({ message: "Test not found for this stage." });
    }

    let score = 0;
    
    // 2. Calculate Score
    if (answers && answers.length > 0) {
      answers.forEach(ans => {
        const question = test.questions.id(ans.questionId);
        if (question && question.correctOptionIndex === ans.selectedIndex) {
          score++;
        }
      });
    }

    // 3. Save Result (NOW WITH PHONE NUMBER)
    await Result.create({
      userId, 
      userName: userName || "Unknown Student", 
      userPhone: userPhone || "N/A", // ⬅️ Saving Phone Number
      userMode: userMode || "offline",         
      language, 
      stage, 
      score, 
      totalQuestions: test.questions.length
    });

    // 4. Return Score
    res.json({ 
      message: "Test Submitted", 
      score: score, 
      total: test.questions.length 
    });

  } catch (error) {
    console.error("Submit Error:", error); 
    res.status(500).json({ message: "Server Error during submission" });
  }
};

// --- ADMIN: Get Results for a specific Stage ---
const getStageResults = async (req, res) => {
  try {
    const { language, stage } = req.query;
    // Sort by score descending (Highest marks first)
    const results = await Result.find({ language, stage }).sort({ score: -1 });
    res.json(results);
  } catch (error) {
    console.error("Get Results Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- ADMIN: Delete Test ---
const deleteTest = async (req, res) => {
  try {
    const { language, stage } = req.body;
    await Test.findOneAndDelete({ language, stage });
    res.json({ message: "Test Deleted Successfully" });
  } catch (error) {
    console.error("Delete Test Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { updateTest, getTest, submitTest, getStageResults, deleteTest };