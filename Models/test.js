const mongoose = require("mongoose");

const questionSchema = new mongoose.Schema({
  questionText: { type: String, required: true },
  options: [{ type: String, required: true }], // Array of 4 strings
  correctOptionIndex: { type: Number, required: true }, // 0, 1, 2, or 3
});

const testSchema = new mongoose.Schema({
  language: { type: String, enum: ["English", "Hindi"], required: true },
  stage: { type: String, required: true }, // e.g., "stage1", "stage2"
  isActive: { type: Boolean, default: false }, // Admin toggles this to "Schedule" the test
  durationMinutes: { type: Number, default: 25 },
  questions: [questionSchema], // List of questions
  
  // 🚀 TTL `expires` field removed so test results & data remain permanently saved
  createdAt: { 
    type: Date, 
    default: Date.now, 
  } 
}, { timestamps: true });

module.exports = mongoose.model("Test", testSchema);