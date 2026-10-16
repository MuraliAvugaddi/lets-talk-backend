const mongoose = require("mongoose");

// One row = "this student did their speaking practice in this class today".
// Written by the trainer from the live classroom ("Mark practiced").
const practiceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    userName: { type: String, default: "" },
    language: { type: String, enum: ["English", "Hindi"], required: true },
    stage: { type: String, required: true }, // "stage1" ... "stage7"
    section: { type: String, default: "" }, // "A" / "B" ... ("" for Hindi)
    date: { type: String, required: true }, // DD-MM-YYYY (IST)
    trainerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    trainerName: { type: String, default: "" },
    practicedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// A student practices once per class per day
practiceSchema.index({ userId: 1, date: 1, language: 1, stage: 1 }, { unique: true });
practiceSchema.index({ date: 1, language: 1, stage: 1 });

module.exports = mongoose.model("Practice", practiceSchema);
