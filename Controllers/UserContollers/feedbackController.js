const Feedback = require("../../Models/feedback");
const User = require("../../Models/users");
const { normalizeDateKey, istDayRange } = require("../../utils/time");
const { normMode, isAll, isValidId } = require("../../utils/normalize");

// POST /api/user/feedback  { userId, rating, comment, (name, phone, mode) }
const submitFeedback = async (req, res) => {
  try {
    const userId = req.user ? String(req.user._id) : req.body.userId;
    const rating = Number(req.body.rating);
    const comment = String(req.body.comment || "").trim().slice(0, 2000);

    if (!isValidId(userId)) return res.status(400).json({ message: "Valid userId required" });
    if (!rating || rating < 1 || rating > 5 || !comment) {
      return res.status(400).json({ message: "Rating (1-5) and comment are required." });
    }

    // Name/phone/mode come from the account, not from the request
    const user = await User.findById(userId).select("name phone mode").lean();
    if (!user) return res.status(404).json({ message: "User not found" });

    const newFeedback = await Feedback.create({
      userId,
      name: user.name,
      phone: user.phone,
      mode: user.mode || normMode(req.body.mode) || "online",
      rating,
      comment,
    });
    // ⚡ Admin feedback screen updates instantly (no refresh)
    if (req.io) req.io.to("admin_room").emit("feedback_new", { feedback: newFeedback });
    res.status(201).json({ message: "Feedback submitted successfully!", data: newFeedback });
  } catch (error) {
    console.error("Submit Feedback Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// GET /api/admin/feedbacks?date=yyyy-MM-dd|all&mode=online|offline|all
const getAllFeedbacks = async (req, res) => {
  try {
    const query = {};
    const mode = normMode(req.query.mode);
    if (mode) query.mode = mode;

    if (!isAll(req.query.date)) {
      const key = normalizeDateKey(req.query.date);
      if (key) {
        const { start, end } = istDayRange(key); // India day, not UTC day
        query.createdAt = { $gte: start, $lte: end };
      }
    }

    const feedbacks = await Feedback.find(query).sort({ createdAt: -1 }).limit(500).lean();
    res.set("Cache-Control", "no-store"); // browsers must never show an old list
    res.status(200).json({ feedbacks });
  } catch (error) {
    console.error("Get Feedbacks Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const deleteFeedback = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ message: "Invalid id" });
    const feedback = await Feedback.findByIdAndDelete(req.params.id);
    if (!feedback) return res.status(404).json({ message: "Feedback not found" });
    if (req.io) req.io.to("admin_room").emit("feedback_deleted", { id: String(feedback._id) });
    res.status(200).json({ message: "Feedback removed successfully" });
  } catch (error) {
    console.error("Delete Feedback Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { submitFeedback, getAllFeedbacks, deleteFeedback };
