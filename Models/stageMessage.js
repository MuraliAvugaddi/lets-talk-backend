const mongoose = require("mongoose");

// 📨 Message from the admin to ONE group of students
//    e.g. English • Stage 2 • Online students only
const stageMessageSchema = new mongoose.Schema(
  {
    title: { type: String, default: "", maxlength: 120 },
    message: { type: String, required: true, maxlength: 2000 },
    language: { type: String, enum: ["English", "Hindi", "All"], default: "English" },
    stages: { type: [String], default: [] }, // [] = every stage
    mode: { type: String, enum: ["all", "online", "offline"], default: "all" },
    sentTo: { type: Number, default: 0 }, // how many students matched when it was sent
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    sentByName: { type: String, default: "" },
    // 🔔 also every notification the institute sends (notice, special class,
    //    online day, new test, fee …) is kept here → the student's Messages page
    kind: { type: String, default: "message" }, // message | notice | special | rain | test | fee | stage | mode
    student: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, // set → only this student
  },
  { timestamps: true }
);

stageMessageSchema.index({ createdAt: -1 });
stageMessageSchema.index({ student: 1, createdAt: -1 });

module.exports = mongoose.model("StageMessage", stageMessageSchema);
