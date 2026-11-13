const mongoose = require("mongoose");

// 🚪 A student who stopped the course in the middle.
// Admin marks it (with a reason) → all access is switched off.
// The principal opens the list, calls the student, writes call notes,
// and can bring the student back (access is given back exactly as before).
const noteSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true },
    byName: { type: String, default: "" },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const dropoutSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, default: "" },
    phone: { type: String, default: "" },
    mode: { type: String, default: "" },
    onlineSection: { type: String, default: "" },
    batchTime: { type: String, default: "" },
    joinedAt: { type: Date, default: null },

    // where the student stopped
    language: { type: String, enum: ["English", "Hindi"], required: true },
    stage: { type: String, required: true }, // stage1..stage7
    reason: { type: String, required: true, trim: true },
    reasonType: { type: String, default: "" }, // quick pick: Fees, Moved, Timing, Health, Job/Studies, Not interested, Other

    // access before dropping (given back on rejoin)
    englishAccess: { type: Object, default: {} },
    hindiAccess: { type: Object, default: {} },
    englishDone: { type: Object, default: {} },
    hindiDone: { type: Object, default: {} },

    // fee picture at the moment of dropping
    feeStatus: { type: String, default: "unpaid" },
    lastFeePaymentDate: { type: Date, default: null },
    monthsPending: { type: Number, default: 0 },

    status: { type: String, enum: ["dropped", "rejoined"], default: "dropped", index: true },
    droppedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    droppedByName: { type: String, default: "" },
    rejoinedAt: { type: Date, default: null },
    rejoinedByName: { type: String, default: "" },

    // principal's call notes ("Called, will come back next month" …)
    notes: { type: [noteSchema], default: [] },
  },
  { timestamps: true }
);

dropoutSchema.index({ createdAt: -1 });
dropoutSchema.index({ language: 1, stage: 1, status: 1 });

module.exports = mongoose.models.Dropout || mongoose.model("Dropout", dropoutSchema);
