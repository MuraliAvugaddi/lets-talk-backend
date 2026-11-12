const express = require("express");
const router = express.Router();
const {
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
} = require("../../Controllers/UserContollers/testController");
const {
  saveDraft,
  myDrafts,
  deleteMyDraft,
  listDrafts,
  getDraft,
  reviewDraft,
} = require("../../Controllers/UserContollers/testDraftController");
const { auth, requireAuth } = require("../../middleware/authMiddleware");

const ADMIN = ["manager", "admin"];
const STAFF = ["teacher", "manager", "admin"];

// Admin
router.post("/admin/update-test", requireAuth(...ADMIN), updateTest); // publish (new version)
router.get("/admin/get-test", auth(...STAFF), getAdminTest); // live test + submissions
router.post("/admin/test-active", requireAuth(...ADMIN), setTestActive); // pause / resume
router.delete("/admin/delete-test", requireAuth(...ADMIN), deleteTest); // deletes test only, results kept
router.get("/admin/results", auth(...STAFF), getResults);

// ✍️ Trainer writes a test → admin approves → admin releases
router.post("/trainer/test-draft", requireAuth(...STAFF), saveDraft);
router.get("/trainer/test-drafts", requireAuth(...STAFF), myDrafts);
router.delete("/trainer/test-draft", requireAuth(...STAFF), deleteMyDraft);
router.get("/admin/test-drafts", requireAuth(...ADMIN), listDrafts);
router.get("/admin/test-draft", requireAuth(...ADMIN), getDraft);
router.post("/admin/test-draft/review", requireAuth(...ADMIN), reviewDraft);

// Student
router.get("/user/test-overview", auth(), getTestOverview); // all 7 stages in one call
router.get("/user/get-test", auth(), getTest);
router.post("/user/start-test", auth(), startTest); // starts the server-side countdown
router.post("/user/submit-test", auth(), submitTest);
router.get("/user/my-results", auth(), getMyTestResults);

module.exports = router;
