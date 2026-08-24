const Feedback = require("../../Models/feedback");

// @desc    Submit student feedback (User side)
// @route   POST /api/user/feedback
const submitFeedback = async (req, res) => {
  try {
    const { userId, name, phone, mode, rating, comment } = req.body;
    if (!rating || !comment) {
      return res.status(400).json({ message: "Rating and comment are required." });
    }
    const newFeedback = await Feedback.create({
      userId,
      name,
      phone,
      mode: mode ? mode.toLowerCase() : "online",
      rating,
      comment,
    });
    res.status(201).json({ message: "Feedback submitted successfully!", data: newFeedback });
  } catch (error) {
    console.error("Submit Feedback Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Get all student feedback with Date & Mode Filters (Admin side)
// @route   GET /api/admin/feedbacks
const getAllFeedbacks = async (req, res) => {
  try {
    const { date, mode } = req.query;
    let query = {};

    // Mode Filter
    if (mode && mode.toLowerCase() !== "all") {
      query.mode = mode.toLowerCase();
    }

    // Date Filter (Specific Day Query: Start of day to End of day)
    if (date && date.toLowerCase() !== "all") {
      const selected = new Date(date);
      const startOfDay = new Date(selected.setUTCHours(0, 0, 0, 0));
      const endOfDay = new Date(selected.setUTCHours(23, 59, 59, 999));

      query.createdAt = {
        $gte: startOfDay,
        $lte: endOfDay,
      };
    }

    const feedbacks = await Feedback.find(query)
      .sort({ createdAt: -1 })
      .populate("userId", "name phone mode");

    res.status(200).json({ feedbacks });
  } catch (error) {
    console.error("Get Feedbacks Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Delete feedback item (Admin side)
// @route   DELETE /api/admin/feedbacks/:id
const deleteFeedback = async (req, res) => {
  try {
    const feedback = await Feedback.findByIdAndDelete(req.params.id);
    if (!feedback) {
      return res.status(404).json({ message: "Feedback not found" });
    }
    res.status(200).json({ message: "Feedback removed successfully" });
  } catch (error) {
    console.error("Delete Feedback Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { submitFeedback, getAllFeedbacks, deleteFeedback };