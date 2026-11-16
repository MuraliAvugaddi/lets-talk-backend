// =====================================================
// 👋 TRAINER ALERTS — the bell in the trainer app
//   GET  /api/trainer/alerts          → last 60 days (newest first) + unread count
//   POST /api/trainer/alerts/read     { ids?: [...] }  (no ids = mark all read)
// =====================================================
const mongoose = require("mongoose");
const TrainerAlert = require("../../Models/trainerAlert");
const { isValidId } = require("../../utils/normalize");

const listMyAlerts = async (req, res) => {
  try {
    const trainerId = req.user._id;
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 300);
    const [alerts, unread] = await Promise.all([
      TrainerAlert.find({ trainerId }).sort({ createdAt: -1 }).limit(limit).lean(),
      TrainerAlert.countDocuments({ trainerId, read: false }),
    ]);
    res.status(200).json({ alerts, unread });
  } catch (error) {
    console.error("Trainer Alerts Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const markAlertsRead = async (req, res) => {
  try {
    const q = { trainerId: req.user._id, read: false };
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String).filter(isValidId) : [];
    if (ids.length) q._id = { $in: ids.map((i) => new mongoose.Types.ObjectId(i)) };
    await TrainerAlert.updateMany(q, { $set: { read: true } });
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Trainer Alerts Read Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { listMyAlerts, markAlertsRead };
