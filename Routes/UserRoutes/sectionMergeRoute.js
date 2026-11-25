const express = require("express");
const router = express.Router();
const {
  getActiveMerges,
  mergeSections,
  cancelMerge,
  resolveEffectiveSection,
} = require("../../Controllers/UserContollers/sectionMergeController");
const hindi = require("../../Controllers/UserContollers/hindiStageMergeController");
const { auth, requireAuth } = require("../../middleware/authMiddleware");

const ADMIN = ["manager", "admin"];
const STAFF = ["teacher", "manager", "admin"];

router.get("/section-merges", auth(...STAFF), getActiveMerges);
router.post("/merge-sections", requireAuth(...ADMIN), mergeSections);
// admin — or that class's trainer ("I'm back") — checked inside
router.delete("/section-merges/:id", requireAuth(...STAFF), cancelMerge);
router.get("/resolve-section", auth(), resolveEffectiveSection);

// 🔀 HINDI STAGE MERGE (Hindi has no sections → stages are merged: Stage 2 → Stage 1)
router.get("/hindi-stage-merges", auth(...STAFF), hindi.getHindiMerges);
router.post("/merge-hindi-stages", requireAuth(...ADMIN), hindi.mergeHindiStages);
router.delete("/hindi-stage-merges", requireAuth(...ADMIN), hindi.cancelAllHindiMerges);
// admin — or that class's Hindi trainer ("I'm back") — checked inside
router.delete("/hindi-stage-merges/:id", requireAuth(...STAFF), hindi.cancelHindiMerge);

module.exports = router;
