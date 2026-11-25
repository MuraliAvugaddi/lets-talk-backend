const mongoose = require("mongoose");

// =====================================================
// TEMPORARY HINDI STAGE MERGE
// Hindi has no sections, so the admin merges STAGES instead:
//   guestStage (trainer absent) students join hostStage's live class.
//   Example: Stage 2 → Stage 1. Several stages can join one host
//   (Stage 2, 3, 4 … 7 → Stage 1 = all 7 stages in one class).
// Attendance + practice are still saved in the student's own stage.
// =====================================================
const stageMergeSchema = new mongoose.Schema(
  {
    language: { type: String, enum: ["Hindi"], default: "Hindi", required: true },
    hostStage: { type: String, required: true }, // "stage1" — trainer present
    guestStage: { type: String, required: true }, // "stage2" — trainer absent
    isActive: { type: Boolean, default: true },
    mergedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    mergedByName: { type: String, default: "" },
  },
  { timestamps: true }
);

stageMergeSchema.index({ language: 1, guestStage: 1, isActive: 1 });
stageMergeSchema.index({ language: 1, hostStage: 1, isActive: 1 });

module.exports = mongoose.models.StageMerge || mongoose.model("StageMerge", stageMergeSchema);
