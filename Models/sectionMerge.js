const mongoose = require("mongoose");

// Temporary merge (English online only): guestSection students join hostSection's class
const sectionMergeSchema = new mongoose.Schema(
  {
    language: { type: String, enum: ["English", "Hindi"], default: "English", required: true },
    stage: { type: String, required: true },
    hostSection: { type: String, required: true }, // trainer present
    guestSection: { type: String, required: true }, // trainer absent
    isActive: { type: Boolean, default: true },
    mergedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    mergedByName: { type: String, default: "" },
  },
  { timestamps: true }
);

sectionMergeSchema.index({ language: 1, stage: 1, guestSection: 1, isActive: 1 });
sectionMergeSchema.index({ language: 1, stage: 1, hostSection: 1, isActive: 1 });

module.exports = mongoose.models.SectionMerge || mongoose.model("SectionMerge", sectionMergeSchema);
