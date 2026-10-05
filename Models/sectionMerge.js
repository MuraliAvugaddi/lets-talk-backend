const mongoose = require("mongoose");

const sectionMergeSchema = new mongoose.Schema(
  {
    language: { type: String, enum: ["English", "Hindi"], required: true },
    stage: { type: String, required: true },
    hostSection: { type: String, required: true },
    guestSection: { type: String, required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SectionMerge", sectionMergeSchema);