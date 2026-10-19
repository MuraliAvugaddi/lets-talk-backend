const mongoose = require("mongoose");

// When a student pressed "Start" on a test version. The countdown is calculated from
// this on the SERVER, so closing / reopening the app never gives extra time.
const testStartSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    language: { type: String, required: true },
    stage: { type: String, required: true },
    testVersion: { type: Number, required: true },
    startedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

testStartSchema.index({ userId: 1, language: 1, stage: 1, testVersion: 1 }, { unique: true });

module.exports = mongoose.models.TestStart || mongoose.model("TestStart", testStartSchema);
