const mongoose = require("mongoose");

// One row = "this student did their speaking practice in this class today".
// Written by the trainer from the live classroom ("Mark practiced").
const practiceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    userName: { type: String, default: "" },
    language: { type: String, enum: ["English", "Hindi"], required: true },
    stage: { type: String, required: true }, // "stage1" ... "stage7"
    section: { type: String, default: "" }, // the STUDENT's own section "A" / "B" ... ("" for Hindi)
    hostSection: { type: String, default: "" }, // set when practiced in another section's class (merge day)
    date: { type: String, required: true }, // DD-MM-YYYY (IST)
    trainerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    trainerName: { type: String, default: "" },
    practicedAt: { type: Date, default: Date.now },

    // ⭐ Trainer's rating of this practice (1–5), 0 = not rated yet
    rating: { type: Number, min: 0, max: 5, default: 0 },
    note: { type: String, default: "" }, // e.g. "Good pronunciation, needs confidence"
    tags: { type: [String], default: [] }, // quick picks: Fluency, Pronunciation, Grammar, Confidence
  },
  { timestamps: true }
);

// A student practices once per class per day
practiceSchema.index({ userId: 1, date: 1, language: 1, stage: 1 }, { unique: true });
practiceSchema.index({ date: 1, language: 1, stage: 1 });

module.exports = mongoose.model("Practice", practiceSchema);
