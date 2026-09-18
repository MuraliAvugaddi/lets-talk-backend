const mongoose = require("mongoose");

const teacherSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true },
    mode: { type: String, enum: ["online", "offline"], required: true },
    language: { type: String, enum: ["English", "Hindi"], default: "English" },
    role: { type: String, enum: ["teacher", "manager", "admin"], default: "teacher" },
    teacherStage: { type: String, default: "stage1" },
    teacherSection: { type: String, default: "None", trim: true },
    sessionToken: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Teacher", teacherSchema);