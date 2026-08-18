const mongoose = require("mongoose");

const resultSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  userName: { type: String }, 
  userPhone: { type: String }, // <--- NEW: Store Phone Number
  userMode: { type: String },  // "online" or "offline"
  language: { type: String, required: true },
  stage: { type: String, required: true },
  score: { type: Number, required: true },
  totalQuestions: { type: Number, required: true },
  completedAt: { type: Date, default: Date.now, expires: '4d' } 
});

module.exports = mongoose.model("Result", resultSchema);