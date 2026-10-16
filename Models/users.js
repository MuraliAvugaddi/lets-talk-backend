const mongoose = require("mongoose");

const accessShape = {
  stage1: { type: Boolean, default: false },
  stage2: { type: Boolean, default: false },
  stage3: { type: Boolean, default: false },
  stage4: { type: Boolean, default: false },
  stage5: { type: Boolean, default: false },
  stage6: { type: Boolean, default: false },
  stage7: { type: Boolean, default: false },
};

// Per-stage class timing, e.g. stage1: "05:30 AM - 07:00 AM" ("" = use default batchTime)
const batchShape = {
  stage1: { type: String, default: "" },
  stage2: { type: String, default: "" },
  stage3: { type: String, default: "" },
  stage4: { type: String, default: "" },
  stage5: { type: String, default: "" },
  stage6: { type: String, default: "" },
  stage7: { type: String, default: "" },
};

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true },
    mode: { type: String, enum: ["online", "offline"], required: true },

    onlineSection: { type: String, default: "None", trim: true },
    // Default class timing chosen at signup, e.g. "05:30 AM - 07:00 AM" (see utils/batches.js). "" = not chosen.
    batchTime: { type: String, default: "", trim: true },
    // Timing per enabled stage (a student can attend Stage 1 at 5:30 AM and Stage 2 at 3:30 PM)
    englishBatch: batchShape,
    hindiBatch: batchShape,
    language: { type: String, enum: ["English", "Hindi"], default: "English" },

    feeStatus: { type: String, enum: ["paid", "unpaid"], default: "unpaid" },
    lastFeePaymentDate: { type: Date, default: null },

    feePaymentScreenshot: { type: String, default: "" },
    feePaymentStatus: {
      type: String,
      enum: ["not_submitted", "pending_verification", "verified", "rejected"],
      default: "not_submitted",
    },
    feeSubmittedAt: { type: Date, default: null },
    feeVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    sessionToken: { type: String, default: "" },

    englishAccess: accessShape,
    hindiAccess: accessShape,

    role: { type: String, enum: ["student", "teacher", "manager", "admin"], default: "student" },
    teacherStage: { type: String, default: "stage1" },
    teacherSection: { type: String, default: "None" },
  },
  { timestamps: true }
);

userSchema.index({ role: 1, mode: 1 });
userSchema.index({ feePaymentStatus: 1 });
userSchema.index({ role: 1, onlineSection: 1 });
userSchema.index({ role: 1, batchTime: 1 });

module.exports = mongoose.model("User", userSchema);
