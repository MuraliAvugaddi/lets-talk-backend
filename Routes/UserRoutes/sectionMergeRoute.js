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
router.delete("/section-merges/:id", requireAuth(...ADMIN), cancelMerge);
router.get("/resolve-section", auth(), resolveEffectiveSection);

module.exports = router;
