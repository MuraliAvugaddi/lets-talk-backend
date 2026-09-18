const mongoose = require('mongoose');

const BatchSchema = new mongoose.Schema({
  batchNumber: { type: Number, required: true, min: 1, max: 7 }, // 1 to 7
  timeSlot: { type: String, required: true }, // e.g., "05:30 - 07:00"
  period: { type: String, enum: ['AM', 'PM'], required: true },
  currentMeetLink: { type: String, default: null }
});

module.exports = mongoose.model('Batch', BatchSchema);a