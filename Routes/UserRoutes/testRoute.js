const express = require("express");
const router = express.Router();

// 1. IMPORT deleteTest HERE ⬇️
const { 
  updateTest, 
  getTest, 
  submitTest, 
  getStageResults, 
  deleteTest // <--- Add this!
} = require("../../Controllers/UserContollers/testController");

const { protect } = require("../../middleware/authMiddleware");

// --- ADMIN ROUTES ---
router.post("/admin/update-test", updateTest);
router.get("/admin/results", getStageResults);
router.delete("/admin/delete-test", deleteTest); // Now this will work

// --- USER ROUTES ---
router.get("/user/get-test", getTest);
router.post("/user/submit-test", submitTest);

module.exports = router;