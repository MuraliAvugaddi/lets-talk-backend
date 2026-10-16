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
const { auth, requireAuth } = require("../../middleware/authMiddleware");

const ADMIN = ["manager", "admin"];
const STAFF = ["teacher", "manager", "admin"];

router.post("/admin/update-test", requireAuth(...ADMIN), updateTest);
router.delete("/admin/delete-test", requireAuth(...ADMIN), deleteTest);
router.get("/admin/results", auth(...STAFF), getResults);

router.get("/user/get-test", auth(), getTest);
router.post("/user/submit-test", auth(), submitTest);
router.get("/user/my-results", auth(), getMyTestResults);

module.exports = router;
