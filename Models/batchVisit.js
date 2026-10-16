const mongoose = require("mongoose");

// A student joined a live class OUTSIDE their own batch time
// (e.g. timing 03:30 PM but joined the 09:00 AM class).
// These joins do NOT count as attendance; admin + trainer see them in a list.
const batchVisitSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    userName: { type: String, default: "" },
    userPhone: { type: String, default: "" },
    language: { type: String, enum: ["English", "Hindi"], required: true },
    stage: { type: String, required: true },
    section: { type: String, default: "" },
    date: { type: String, required: true }, // DD-MM-YYYY (IST)
    ownBatch: { type: String, default: "" }, // the student's timing
    joinedBatch: { type: String, default: "" }, // the class they actually joined
    joinedAt: { type: Date, default: Date.now },
    lastJoinedAt: { type: Date, default: Date.now },
    joinCount: { type: Number, default: 1 },
  },
  { timestamps: true }
);

batchVisitSchema.index({ userId: 1, date: 1, language: 1, stage: 1, joinedBatch: 1 }, { unique: true });
batchVisitSchema.index({ date: 1, language: 1, stage: 1 });

module.exports = mongoose.model("BatchVisit", batchVisitSchema);
