const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true },
    mode: { type: String, enum: ["online", "offline"], required: true },

    sessionToken: { type: String, default: "" },

    // ⬇️ 7 Stages for English
    englishAccess: {
      stage1: { type: Boolean, default: false },
      stage2: { type: Boolean, default: false },
      stage3: { type: Boolean, default: false },
      stage4: { type: Boolean, default: false },
      stage5: { type: Boolean, default: false },
      stage6: { type: Boolean, default: false },
      stage7: { type: Boolean, default: false },
    },

    // ⬇️ 7 Stages for Hindi
    hindiAccess: {
      stage1: { type: Boolean, default: false },
      stage2: { type: Boolean, default: false },
      stage3: { type: Boolean, default: false },
      stage4: { type: Boolean, default: false },
      stage5: { type: Boolean, default: false },
      stage6: { type: Boolean, default: false },
      stage7: { type: Boolean, default: false },
    },
    role: { type: String, enum: ["student", "admin"], default: "student" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);