const mongoose = require("mongoose");

const feeHistorySchema = new mongoose.Schema(
  {
    monthYear: { type: String, required: true, unique: true }, // e.g., "10-2026"
    totalStudents: { type: Number, default: 0 },
    totalPaid: { type: Number, default: 0 },
    totalUnpaid: { type: Number, default: 0 },
    archivedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("FeeHistory", feeHistorySchema);

