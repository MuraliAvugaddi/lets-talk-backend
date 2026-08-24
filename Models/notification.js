const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema({
  message: { type: String, required: true },
  targetMode: { 
    type: String, 
    enum: ["all", "online", "offline"], 
    default: "all" 
  },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Notification", notificationSchema);