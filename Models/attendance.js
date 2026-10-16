const mongoose = require("mongoose");

const attendanceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    userName: { type: String, required: true },
    userPhone: { type: String, required: true },
    userMode: { type: String, enum: ["online", "offline"], required: true },
    language: { type: String, enum: ["English", "Hindi"], default: "English" },
    stage: { type: String, required: true }, // canonical: "stage1" ... "stage7"
    batchTime: { type: String, required: false, default: "Live Stream" },
    date: { type: String, required: true }, // canonical: "DD-MM-YYYY" (IST)

    // Final verdict shown everywhere
    status: {
      type: String,
      enum: ["Present", "Late", "Partial", "Absent"],
      default: "Absent",
    },
    // Verdict from arrival time only (online status is derived from this + minutes)
    arrivalStatus: { type: String, enum: ["Present", "Late", "Absent"], default: "Absent" },

    // Offline (GPS) tracking
    markedAt: { type: Date },
    location: { lat: Number, lng: Number },

    // Online live-class tracking
    firstJoinAt: { type: Date }, // first time they joined today (for display)
    joinTime: { type: Date }, // start of the CURRENT open segment (null = not in class)
    lastActiveTime: { type: Date },
    leaveTime: { type: Date },
    secondsSpent: { type: Number, default: 0 }, // exact counter
    totalMinutesSpent: { type: Number, default: 0 }, // integer minutes (apps read this)
  },
  { timestamps: true }
);

// One record per user / day / stage / language / batch.
// The OLD unique index (without language) made a student's English and Hindi
// class on the same day collide. index.js drops the old index on startup.
attendanceSchema.index(
  { userId: 1, date: 1, stage: 1, language: 1, batchTime: 1 },
  { unique: true, name: "uniq_user_day_stage_lang_batch" }
);

// Query indexes for the admin / trainer screens
attendanceSchema.index({ date: 1, stage: 1, language: 1 });
attendanceSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("Attendance", attendanceSchema);
