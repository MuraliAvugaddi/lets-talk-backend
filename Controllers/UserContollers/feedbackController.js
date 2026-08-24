//const Feedback = require("../Models/feedback");
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

// @desc    Get all student feedback (Admin side)
// @route   GET /api/admin/feedbacks
const getAllFeedbacks = async (req, res) => {
  try {
    const feedbacks = await Feedback.find({})
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