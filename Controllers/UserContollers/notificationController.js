const Notification = require("../../Models/notification");

// Admin: Set a new notification with target mode
const setNotification = async (req, res) => {
  try {
    const { message, targetMode } = req.body;
    await Notification.deleteMany({ targetMode: targetMode || "all" });
    
    const newNotif = await Notification.create({ 
      message, 
      targetMode: targetMode || "all" 
    });
    res.status(200).json({ message: "Notification Posted", data: newNotif });
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
};

// Admin: Delete notification
const deleteNotification = async (req, res) => {
  try {
    const { targetMode } = req.query;
    if (targetMode) {
      await Notification.deleteMany({ targetMode });
    } else {
      await Notification.deleteMany({});
    }
    res.status(200).json({ message: "Notification Removed" });
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
};

// User: Get mode-specific notification
const getNotification = async (req, res) => {
  try {
    const { mode } = req.query; // 'online' or 'offline'
    const query = mode 
      ? { targetMode: { $in: ["all", mode.toLowerCase()] } }
      : { targetMode: "all" };

    const notif = await Notification.findOne(query).sort({ createdAt: -1 });
    if (notif) {
      res.json({ hasNotification: true, message: notif.message, targetMode: notif.targetMode });
    } else {
      res.json({ hasNotification: false });
    }
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { setNotification, deleteNotification, getNotification };