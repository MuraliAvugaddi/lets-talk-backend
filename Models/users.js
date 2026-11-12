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
    // 🔁 Temporary mode change (admin: "online for 2 days"). modeBase = the student's
    // normal mode, modeTempUntil = when it goes back by itself. Both empty = normal.
    modeBase: { type: String, enum: ["", "online", "offline"], default: "" },
    modeTempUntil: { type: Date, default: null },
    // 🚪 Dropout: admin marked that the student stopped coming (all access was switched off)
    isDropout: { type: Boolean, default: false },
    // 🖼 profile photo (Cloudinary)
    photoUrl: { type: String, default: "" },
    photoPublicId: { type: String, default: "" },
    droppedAt: { type: Date, default: null },

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
    // Which course this month's fee screenshot is for (student picks it when uploading)
    feeLanguage: { type: String, enum: ["", "English", "Hindi"], default: "" },
    feeScreenshotPublicId: { type: String, default: "" }, // Cloudinary id (so a wrong screenshot can be deleted)
    feeVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    sessionToken: { type: String, default: "" },

    // 🔔 phones of this user for push notifications (max 5, newest last)
    fcmTokens: { type: [String], default: [], select: true },

    englishAccess: accessShape,
    hindiAccess: accessShape,

    role: { type: String, enum: ["student", "teacher", "manager", "admin"], default: "student" },
    teacherStage: { type: String, default: "stage1" },
    teacherSection: { type: String, default: "None" },
  },
  { timestamps: true }
);

// ⚡ Login memory (utils/userCache): forget a user the moment they are changed
const userCache = require("../utils/userCache");
userSchema.post("save", (doc) => userCache.forget(doc && doc._id));
userSchema.post(["deleteOne", "findOneAndDelete"], { document: false, query: true }, function () {
  userCache.clearAll();
});
userSchema.post(["updateOne", "findOneAndUpdate", "replaceOne"], function () {
  const f = this.getFilter ? this.getFilter() : {};
  const id = f && f._id;
  if (id && (typeof id === "string" || typeof id.toHexString === "function")) userCache.forget(String(id));
  else userCache.clearAll(); // many users / unknown filter → forget everyone (safe)
});
userSchema.post(["updateMany", "deleteMany", "bulkWrite"], () => userCache.clearAll());

userSchema.index({ role: 1, mode: 1 });
userSchema.index({ feePaymentStatus: 1 });
userSchema.index({ role: 1, onlineSection: 1 });
userSchema.index({ role: 1, batchTime: 1 });
userSchema.index({ modeTempUntil: 1 }, { sparse: true });

module.exports = mongoose.model("User", userSchema);
