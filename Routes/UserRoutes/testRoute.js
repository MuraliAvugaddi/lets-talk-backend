const express = require("express");
const router = express.Router();

const {
  updateTest,
  deleteTest,
  getResults,
  getTest,
  submitTest,
  getMyTestResults,
} = require("../../Controllers/UserContollers/testController");

// --- ADMIN ROUTES ---
router.post("/admin/update-test", updateTest);
router.delete("/admin/delete-test", deleteTest);
router.get("/admin/results", getResults);

// --- USER ROUTES ---
router.get("/user/get-test", getTest);
router.post("/user/submit-test", submitTest);
router.get("/user/my-results", getMyTestResults);

module.exports = router;