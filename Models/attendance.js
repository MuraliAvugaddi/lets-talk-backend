  const mongoose = require("mongoose");

  const attendanceSchema = new mongoose.Schema(
    {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
      userName: { type: String, required: true },
      userPhone: { type: String, required: true },
      userMode: { type: String, enum: ["online", "offline"], required: true },
      language: { type: String, enum: ["English", "Hindi"], default: "English" },
      stage: { type: String, required: true }, // "Stage 1" ... "Stage 7"
      batchTime: { type: String, required: false, default: "Live Stream" }, // 🚀 Made optional with default
      date: { type: String, required: true }, // "D-M-YYYY"

      // Attendance Verdict
      status: {
        type: String,
        enum: ["Present", "Late", "Partial", "Absent"],
        default: "Absent",
      },

      // Offline Tracking
      markedAt: { type: Date },
      location: {
        lat: Number,
        lng: Number,
      },

      // Online Live Class Time-Tracking
      joinTime: { type: Date },
      lastActiveTime: { type: Date },
      leaveTime: { type: Date },
      totalMinutesSpent: { type: Number, default: 0 },
    },
    { timestamps: true }
  );

  // One attendance record per user per stage per batch per day (sparse or flexible)
  attendanceSchema.index({ userId: 1, stage: 1, date: 1, batchTime: 1 }, { unique: true, sparse: true });

  module.exports = mongoose.model("Attendance", attendanceSchema);