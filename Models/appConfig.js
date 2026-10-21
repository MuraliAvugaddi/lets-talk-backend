const mongoose = require("mongoose");

// Small key → value settings (e.g. "app_version")
const appConfigSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedByName: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.models.AppConfig || mongoose.model("AppConfig", appConfigSchema); 