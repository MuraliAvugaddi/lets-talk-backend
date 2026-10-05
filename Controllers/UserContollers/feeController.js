const User = require("../../Models/users");
const FeeHistory = require("../../Models/feeHistory");
const { uploadBufferToCloudinary } = require("../../utils/cloudinary");

// --- STUDENT: Upload Screenshot ---
const uploadFeeScreenshot = async (req, res) => {
  try {
    const { userId } = req.body;
    if (!req.file) {
      return res.status(400).json({ message: "No screenshot file uploaded" });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const cloudinaryResponse = await uploadBufferToCloudinary(req.file.buffer);

    user.feePaymentScreenshot = cloudinaryResponse.secure_url;
    user.feePaymentStatus = "pending_verification";
    user.feeSubmittedAt = new Date();
    await user.save();

    // 🚀 CRITICAL: Broadcast real-time fee submission to admin sockets
    if (req.io) {
      req.io.emit('fee_update', { userId: user._id });
      req.io.emit('student_update', { userId: user._id });
    }

    res.status(200).json({ 
      success: true, 
      message: "Screenshot uploaded successfully, waiting for manager review.",
      url: cloudinaryResponse.secure_url 
    });
  } catch (error) {
    console.error("Cloudinary Upload Error:", error);
    res.status(500).json({ message: "Server Error during upload" });
  }
};

// --- MANAGER: Verify / Approve / Reject ---
const verifyFeePayment = async (req, res) => {
  try {
    const { userId, status } = req.body;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    user.feeStatus = status === "verified" ? "paid" : "unpaid";
    user.feePaymentStatus = status;
    if (status === "verified") {
      user.lastFeePaymentDate = new Date();
    }
    await user.save();

    if (req.io) {
      req.io.emit('fee_update', { userId: user._id });
      req.io.emit('student_update', { userId: user._id });
    }

    res.status(200).json({ success: true, message: `Fee status updated to ${status}` });
  } catch (error) {
    console.error("Verify Fee Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- MANAGER: Get Pending Verification Requests (FIXED: Includes Screenshot projection) ---
const getPendingFeeSubmissions = async (req, res) => {
  try {
    const students = await User.find({ feePaymentStatus: "pending_verification" })
      .select("name phone mode onlineSection feePaymentScreenshot feeSubmittedAt feePaymentStatus")
      .lean();
    res.status(200).json({ success: true, students });
  } catch (error) {
    console.error("Get Pending Fees Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- MANAGER: Get All Fee History & Analytics ---
const getAllFeeHistory = async (req, res) => {
  try {
    const now = new Date();
    const currentMonthYear = `${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;

    const totalStudents = await User.countDocuments({ role: "student" });
    const totalPaid = await User.countDocuments({ role: "student", feeStatus: "paid" });
    const totalUnpaid = totalStudents - totalPaid;

    let historyRecords = await FeeHistory.find({}).sort({ archivedAt: -1 }).lean();

    const currentLiveSummary = {
      monthYear: currentMonthYear,
      totalStudents,
      totalPaid,
      totalUnpaid,
      isCurrentMonth: true,
    };

    // Also fetch students who have payment logs for history view
    const students = await User.find({ 
      feePaymentStatus: { $in: ["verified", "rejected", "pending_verification"] } 
    })
      .select("name phone mode onlineSection feePaymentScreenshot feeSubmittedAt feePaymentStatus lastFeePaymentDate")
      .sort({ updatedAt: -1 })
      .lean();

    res.status(200).json({ 
      success: true, 
      students, // 🚀 Added students list for the history tab list view
      currentMonth: currentLiveSummary,
      history: [currentLiveSummary, ...historyRecords] 
    });
  } catch (error) {
    console.error("Get Fee History Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { 
  uploadFeeScreenshot, 
  verifyFeePayment, 
  getPendingFeeSubmissions, 
  getAllFeeHistory 
};