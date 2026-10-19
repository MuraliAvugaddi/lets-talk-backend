const mongoose = require("mongoose");

const questionSchema = new mongoose.Schema({
  questionText: { type: String, required: true },
  options: [{ type: String, required: true }], // Array of 4 strings
  correctOptionIndex: { type: Number, required: true }, // 0, 1, 2, or 3
});

// ⚠️ NO `expires` / TTL anywhere: tests stay until the admin deletes them.
// (An old TTL index left in MongoDB was deleting tests by itself — index.js drops it on startup.)
const testSchema = new mongoose.Schema(
  {
    language: { type: String, enum: ["English", "Hindi"], required: true },
    stage: { type: String, required: true }, // "stage1" … "stage7"
    isActive: { type: Boolean, default: false }, // admin can pause / resume
    durationMinutes: { type: Number, default: 25 },
    questions: [questionSchema],
    // Set every time the admin publishes. A student who took an OLDER version can take the new one.
    publishedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

testSchema.index({ language: 1, stage: 1 });

// Reuse the model if it was already loaded (stops "Cannot overwrite `Test` model once compiled")
module.exports = mongoose.models.Test || mongoose.model("Test", testSchema);
