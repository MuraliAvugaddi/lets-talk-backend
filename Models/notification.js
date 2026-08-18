const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema({
  message: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

// We only need one active notification document at a time
module.exports = mongoose.model("Notification", notificationSchema);