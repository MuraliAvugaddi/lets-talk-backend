const mongoose = require("mongoose");

// Special class days, switched on/off by the admin. One document per kind:
//   rain     → every OFFLINE trainer + student has class ONLINE (reason in `note`)
//   assembly → special class: everyone (all languages / stages / sections, trainers too)
//              joins ONE live audio class at the time the admin picked
const classModeSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["rain", "assembly"], required: true, unique: true },
    active: { type: Boolean, default: false },
    title: { type: String, default: "", trim: true, maxlength: 120 },
    note: { type: String, default: "", trim: true, maxlength: 300 },
    startTime: { type: String, default: "" }, // assembly: "11:00 AM"
    startMinutes: { type: Number, default: 0 }, // assembly: minutes after midnight (IST)
    sessionKey: { type: String, default: "" }, // new on every start → a fresh live call
    startedAt: { type: Date, default: null },
    startedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    startedByName: { type: String, default: "" },
    endedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ClassMode", classModeSchema);