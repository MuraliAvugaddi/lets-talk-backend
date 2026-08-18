const mongoose = require("mongoose");

const liveLinkSchema = new mongoose.Schema({
  language: { type: String, enum: ["English", "Hindi"], required: true },
  stage: { type: String, required: true }, // "stage1", "stage2"...
  type: { type: String, enum: ["class", "club"], required: true }, // Is it a Class or a Club?
  link: { type: String, required: true }, // The Google Meet URL
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now } 
}, { timestamps: true });

// Ensure only one active link exists per combination
liveLinkSchema.index({ language: 1, stage: 1, type: 1 }, { unique: true });

module.exports = mongoose.model("LiveLink", liveLinkSchema);