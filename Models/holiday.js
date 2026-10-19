const mongoose = require("mongoose");

// 🏖 A holiday (Dasara, Diwali …). Nobody is marked absent on this day,
// and it is NOT a working day in reports / trainer salary.
const holidaySchema = new mongoose.Schema(
  {
    date: { type: String, required: true, unique: true }, // "DD-MM-YYYY" (IST)
    title: { type: String, default: "Holiday", trim: true },
    appliesTo: { type: String, enum: ["all", "students", "trainers"], default: "all" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    createdByName: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Holiday || mongoose.model("Holiday", holidaySchema);
