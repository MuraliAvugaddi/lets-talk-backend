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
  
  // ⬇️ AUTO DELETE: This field creates a TTL index in MongoDB
  createdAt: { 
    type: Date, 
    default: Date.now, 
    expires: '48h' // Document will be automatically removed after 48 hours
  } 
}, { timestamps: true });

module.exports = mongoose.model("Test", testSchema);