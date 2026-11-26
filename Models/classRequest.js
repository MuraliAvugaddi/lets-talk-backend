const mongoose = require("mongoose");

// 🙋 STUDENT REQUEST → TRAINER (→ MANAGER)
//   e.g. "I can't come to the 5:30 AM batch today, can I join the 6:30 PM batch?"
//   student writes → trainer accepts / replies / sends to manager → manager solves
const messageSchema = new mongoose.Schema(
  {
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    byName: { type: String, default: "" },
    role: { type: String, enum: ["student", "teacher", "manager", "admin", "system"], default: "student" },
    text: { type: String, default: "", maxlength: 1000 },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const classRequestSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    studentName: { type: String, default: "" },
    language: { type: String, enum: ["English", "Hindi"], required: true },
    stage: { type: String, required: true }, // stage1…stage7 (student's CURRENT stage)
    section: { type: String, default: "" }, // online English section (A–E)
    mode: { type: String, enum: ["online", "offline"], required: true },
    batchTime: { type: String, default: "" }, // the student's normal batch for this stage
    type: { type: String, enum: ["other_batch", "absent", "other"], default: "other" },
    forDate: { type: String, default: "" }, // "2026-11-27" — the class day this is about (India date)
    preferredBatch: { type: String, default: "" }, // "other_batch": the batch they want today
    status: {
      type: String,
      enum: ["open", "accepted", "escalated", "solved"],
      default: "open",
      index: true,
    },
    trainers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }], // who gets it
    trainerNames: { type: [String], default: [] },
    messages: { type: [messageSchema], default: [] },
    acceptedByName: { type: String, default: "" },
    escalatedByName: { type: String, default: "" },
    escalatedAt: { type: Date, default: null },
    solvedByName: { type: String, default: "" },
    solvedAt: { type: Date, default: null },
    lastActivityAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

classRequestSchema.index({ status: 1, mode: 1, lastActivityAt: -1 });

module.exports = mongoose.model("ClassRequest", classRequestSchema);
