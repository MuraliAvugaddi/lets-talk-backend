const mongoose = require("mongoose");

// 👋 "New student in your class" — shown in the trainer app (bell) + push
// Example: Online manager Priya added Venkat to English Stage 1 • Section A • 05:30 AM - 07:00 AM
const trainerAlertSchema = new mongoose.Schema(
  {
    trainerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    studentName: { type: String, default: "" },
    language: { type: String, default: "English" },
    stage: { type: String, default: "stage1" },
    section: { type: String, default: "" },
    batch: { type: String, default: "" }, // "05:30 AM - 07:00 AM"
    mode: { type: String, default: "online" },
    reason: { type: String, default: "added" }, // added | promoted | rejoined | mode
    // 🔁 online/offline only for some days → "for 2 days (till Sun, 16 Nov)"
    duration: { type: String, default: "" }, // 1d | 2d | 1w | "" (= for good)
    until: { type: Date, default: null },
    byName: { type: String, default: "" },
    byRole: { type: String, default: "" },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

trainerAlertSchema.index({ trainerId: 1, createdAt: -1 });
// old alerts clean themselves up after 60 days
trainerAlertSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 3600 });

module.exports = mongoose.models.TrainerAlert || mongoose.model("TrainerAlert", trainerAlertSchema);
