const Notification = require("../../Models/notification");

// Admin: Post or Update notice for a specific mode
const setNotification = async (req, res) => {
  try {
    const { message, targetMode } = req.body;

    if (!message || !targetMode) {
      return res.status(400).json({ message: "message and targetMode are required." });
    }

    const cleanMode = String(targetMode).toLowerCase().trim(); // 'online' | 'offline' | 'all'
    if (!["online", "offline", "all"].includes(cleanMode)) {
      return res.status(400).json({ message: "targetMode must be online, offline or all" });
    }

    // Remove old active notice specifically for this mode
    await Notification.deleteMany({ targetMode: cleanMode });

    const newNotif = await Notification.create({
      message: message.trim(),
      targetMode: cleanMode,
    });

    // Broadcast live event specifically to the target mode channel
    if (req.io) {
      req.io.emit("new_notification", {
        hasNotification: true,
        message: newNotif.message,
        targetMode: newNotif.targetMode,
        createdAt: newNotif.createdAt,
      });
    }

    return res.status(200).json({
      success: true,
      message: `${cleanMode.toUpperCase()} notification posted successfully`,
      data: newNotif,
    });
  } catch (error) {
    console.error("setNotification error:", error);
    return res.status(500).json({ message: "Server Error" });
  }
};

// Admin: Delete notice specifically for a mode
const deleteNotification = async (req, res) => {
  try {
    const { targetMode } = req.query;

    if (!targetMode) {
      return res.status(400).json({ message: "targetMode query parameter required." });
    }

    const cleanMode = targetMode.toLowerCase().trim();

    // Delete ONLY notices belonging to this mode
    await Notification.deleteMany({ targetMode: cleanMode });

    // Inform clients that this mode's notice was cleared
    if (req.io) {
      req.io.emit("new_notification", {
        hasNotification: false,
        message: null,
        targetMode: cleanMode,
      });
    }

    return res.status(200).json({
      success: true,
      message: `${cleanMode.toUpperCase()} notification removed`,
    });
  } catch (error) {
    console.error("deleteNotification error:", error);
    return res.status(500).json({ message: "Server Error" });
  }
};

// Student & Admin: Fetch active notice strictly by mode
const getNotification = async (req, res) => {
  try {
    const { mode } = req.query;

    if (!mode) {
      return res.status(400).json({ message: "Mode query parameter is required ('online' or 'offline')" });
    }

    const cleanMode = String(mode).toLowerCase().trim();

    // This mode's notice, or one posted for everybody ("all") — newest wins
    const notif = await Notification.findOne({ targetMode: { $in: [cleanMode, "all"] } }).sort({ createdAt: -1 });
    res.set("Cache-Control", "no-store"); // phones / browsers must never show an old notice

    if (notif && notif.message && notif.message.trim().length > 0) {
      return res.status(200).json({
        hasNotification: true,
        message: notif.message,
        targetMode: notif.targetMode,
        createdAt: notif.createdAt,
      });
    }

    return res.status(200).json({
      hasNotification: false,
      message: null,
      targetMode: cleanMode,
    });
  } catch (error) {
    console.error("getNotification error:", error);
    return res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { setNotification, deleteNotification, getNotification };

