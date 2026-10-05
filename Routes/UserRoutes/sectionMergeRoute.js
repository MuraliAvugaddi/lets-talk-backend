const express = require("express");
const router = express.Router();
const {
  getActiveMerges,
  mergeSections,
  cancelMerge,
  resolveEffectiveSection,
} = require("../../Controllers/UserContollers/sectionMergeController");

router.get("/section-merges", getActiveMerges);
router.post("/merge-sections", mergeSections);
router.delete("/section-merges/:id", cancelMerge);
router.get("/resolve-section", resolveEffectiveSection);

module.exports = router;