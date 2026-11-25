const mongoose = require("mongoose");

// =====================================================
// 📚 STUDY MATERIAL uploaded by the admin (one PDF per stage day)
//   English / Hindi • stage1 … stage7 • Day 1 … 60
//   The PDF lives on Cloudinary; the student app downloads it ONCE and keeps
//   it on the phone. A new upload for the same day = version + 1 → phones
//   download the new file and delete the old one.
// =====================================================
const studyMaterialSchema = new mongoose.Schema(
  {
    language: { type: String, enum: ["English", "Hindi"], required: true },
    stage: { type: String, required: true }, // "stage6"
    day: { type: Number, required: true, min: 1, max: 60 },
    title: { type: String, default: "", trim: true, maxlength: 120 },
    subtitle: { type: String, default: "", trim: true, maxlength: 160 }, // short line under the title
    url: { type: String, required: true }, // Cloudinary PDF link
    publicId: { type: String, default: "" },
    bytes: { type: Number, default: 0 },
    originalBytes: { type: Number, default: 0 }, // before compression
    version: { type: Number, default: 1 },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    uploadedByName: { type: String, default: "" },
  },
  { timestamps: true }
);

studyMaterialSchema.index({ language: 1, stage: 1, day: 1 }, { unique: true });

module.exports = mongoose.models.StudyMaterial || mongoose.model("StudyMaterial", studyMaterialSchema);
