const mongoose = require("mongoose");

// One pending OTP per phone + purpose. The code itself is never stored — only a hash.
const otpCodeSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true }, // 10 digits
    purpose: { type: String, enum: ["signup", "reset"], required: true },
    codeHash: { type: String, default: "" }, // our own code (MSG91 / dev / test numbers)
    providerRef: { type: String, default: "" }, // Message Central verificationId (they hold the code)
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 }, // wrong tries for THIS code
    lastSentAt: { type: Date, required: true },
    // daily send counter (IST day) — stops SMS-cost abuse
    day: { type: String, default: "" },
    sentToday: { type: Number, default: 0 },
    verifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

otpCodeSchema.index({ phone: 1, purpose: 1 }, { unique: true });

module.exports = mongoose.models.OtpCode || mongoose.model("OtpCode", otpCodeSchema);
