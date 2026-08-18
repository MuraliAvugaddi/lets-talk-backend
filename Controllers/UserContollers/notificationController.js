const Notification = require("../../Models/notification");

// Admin: Set a new notification (Overwrites previous one)
const setNotification = async (req, res) => {
  try {
    const { message } = req.body;
    // Delete old ones first to ensure only 1 active message
    await Notification.deleteMany({});
    
    const newNotif = await Notification.create({ message });
    res.status(200).json({ message: "Notification Posted", data: newNotif });
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
};

// Admin: Delete notification
const deleteNotification = async (req, res) => {
  try {
    await Notification.deleteMany({});
    res.status(200).json({ message: "Notification Removed" });
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
};

// User: Get current notification
const getNotification = async (req, res) => {
  try {
    const notif = await Notification.findOne().sort({ createdAt: -1 });
    if (notif) {
      res.json({ hasNotification: true, message: notif.message });
    } else {
      res.json({ hasNotification: false });
    }
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { setNotification, deleteNotification, getNotification };