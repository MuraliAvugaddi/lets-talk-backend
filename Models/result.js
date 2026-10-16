const mongoose = require("mongoose");

// NOTE: the old schema had `completedAt: { expires: '4d' }`, a TTL index that
// silently DELETED every result after 4 days. index.js drops that index on startup.
const resultSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    userName: { type: String },
    userPhone: { type: String },
    userMode: { type: String },
    language: { type: String, required: true },
    stage: { type: String, required: true },
    score: { type: Number, required: true },
    totalQuestions: { type: Number, required: true },
    answers: [
      {
        _id: false,
        questionId: { type: String },
        selectedIndex: { type: Number },
      },
    ],
    completedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

resultSchema.index({ userId: 1, language: 1, stage: 1 });
resultSchema.index({ language: 1, stage: 1, completedAt: -1 });

module.exports = mongoose.model("Result", resultSchema);
