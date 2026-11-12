const mongoose = require("mongoose");

// 🔁 Every online ↔ offline change made by the admin (temporary or permanent)
//   status: active    → temporary, still running (goes back at "until")
//           ended     → temporary, already went back
//           cancelled → admin ended it early / changed it again
//           permanent → permanent change
const modeChangeSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, default: "" },
    phone: { type: String, default: "" },
    onlineSection: { type: String, default: "" },
    englishAccess: { type: Object, default: {} },
    hindiAccess: { type: Object, default: {} },

    from: { type: String, enum: ["online", "offline"], required: true },
    to: { type: String, enum: ["online", "offline"], required: true },
    duration: { type: String, enum: ["1d", "2d", "1w", "permanent"], required: true },
    until: { type: Date, default: null },
    reason: { type: String, default: "", trim: true },

    status: { type: String, enum: ["active", "ended", "cancelled", "permanent"], default: "active", index: true },
    endedAt: { type: Date, default: null },

    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    changedByName: { type: String, default: "" },
  },
  { timestamps: true }
);

modeChangeSchema.index({ createdAt: -1 });

module.exports = mongoose.model("ModeChange", modeChangeSchema);
