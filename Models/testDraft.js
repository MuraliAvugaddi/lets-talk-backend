const mongoose = require("mongoose");

// ✍️ A test written by a TRAINER. Students never see it until the admin releases it.
//   pending  → waiting for admin
//   approved → admin checked it, not live yet
//   rejected → admin sent it back (see reviewNote) → trainer can edit + send again
//   released → it is the live test now (copied into Models/test.js)
const draftQuestionSchema = new mongoose.Schema(
  {
    questionText: { type: String, required: true },
    options: [{ type: String, required: true }],
    correctOptionIndex: { type: Number, required: true },
  },
  { _id: false }
);

const testDraftSchema = new mongoose.Schema(
  {
    title: { type: String, default: "", trim: true },
    language: { type: String, enum: ["English", "Hindi"], required: true },
    stage: { type: String, required: true },
    durationMinutes: { type: Number, default: 25 },
    questions: [draftQuestionSchema],

    status: { type: String, enum: ["pending", "approved", "rejected", "released"], default: "pending", index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    createdByName: { type: String, default: "" },

    reviewNote: { type: String, default: "" },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedByName: { type: String, default: "" },
    reviewedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

testDraftSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.models.TestDraft || mongoose.model("TestDraft", testDraftSchema);
