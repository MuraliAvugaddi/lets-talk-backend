const express = require("express");
const router = express.Router();
const {
  getActiveMerges,
  mergeSections,
  cancelMerge,
  resolveEffectiveSection,
} = require("../../Controllers/UserContollers/sectionMergeController");
const { auth, requireAuth } = require("../../middleware/authMiddleware");

const ADMIN = ["manager", "admin"];
const STAFF = ["teacher", "manager", "admin"];

router.get("/section-merges", auth(...STAFF), getActiveMerges);
router.post("/merge-sections", requireAuth(...ADMIN), mergeSections);
// admin — or that class's trainer ("I'm back") — checked inside
router.delete("/section-merges/:id", requireAuth(...STAFF), cancelMerge);
router.get("/resolve-section", auth(), resolveEffectiveSection);

module.exports = router;
