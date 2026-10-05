const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true },
    mode: { type: String, enum: ["online", "offline"], required: true },
    
    // 🚀 Changed from strict enum to a flexible String to prevent validation crashes
    onlineSection: { type: String, default: "None", trim: true },
    
    language: { type: String, enum: ["English", "Hindi"], default: "English" },

    feeStatus: { type: String, enum: ["paid", "unpaid"], default: "unpaid" },
    lastFeePaymentDate: { type: Date, default: null },

    // 🚀 Added Fee Payment Verification Fields for Cloudinary Screenshots
    feePaymentScreenshot: { type: String, default: "" },
    feePaymentStatus: { 
      type: String, 
      enum: ["not_submitted", "pending_verification", "verified", "rejected"], 
      default: "not_submitted" 
    },
    feeSubmittedAt: { type: Date, default: null },

    sessionToken: { type: String, default: "" },

    englishAccess: {
      stage1: { type: Boolean, default: false },
      stage2: { type: Boolean, default: false },
      stage3: { type: Boolean, default: false },
      stage4: { type: Boolean, default: false },
      stage5: { type: Boolean, default: false },
      stage6: { type: Boolean, default: false },
      stage7: { type: Boolean, default: false },
    },

    hindiAccess: {
      stage1: { type: Boolean, default: false },
      stage2: { type: Boolean, default: false },
      stage3: { type: Boolean, default: false },
      stage4: { type: Boolean, default: false },
      stage5: { type: Boolean, default: false },
      stage6: { type: Boolean, default: false },
      stage7: { type: Boolean, default: false },
    },
    
    role: { type: String, enum: ["student", "teacher", "manager", "admin"], default: "student" },
    teacherStage: { type: String, default: "stage1" }, 
    teacherSection: { type: String, default: "None" }, 
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);