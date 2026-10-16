const User = require("../../Models/users");
const FeeHistory = require("../../Models/feeHistory");
const { uploadBufferToCloudinary } = require("../../utils/cloudinary");
const { monthKey } = require("../../utils/time");
const { isValidId } = require("../../utils/normalize");

const notifyAdmins = (req, event, payload) => {
  if (req.io) req.io.to("admin_room").emit(event, payload);
};

// =====================================================
// STUDENT: upload payment screenshot
// POST /api/fee/upload-fee-screenshot  (multipart: screenshot, userId)
// =====================================================
const uploadFeeScreenshot = async (req, res) => {
  try {
    const userId = req.user ? String(req.user._id) : req.body.userId;
    if (!isValidId(userId)) return res.status(400).json({ message: "Valid userId required" });
    if (!req.file) return res.status(400).json({ message: "No screenshot file uploaded" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.feeStatus === "paid") {
      return res.status(400).json({ message: "Your fee for this month is already verified." });
    }

    const cloudinaryResponse = await uploadBufferToCloudinary(req.file.buffer);

    user.feePaymentScreenshot = cloudinaryResponse.secure_url;
    user.feePaymentStatus = "pending_verification";
    user.feeSubmittedAt = new Date();
    await user.save();

    notifyAdmins(req, "fee_update", { userId: user._id });
    notifyAdmins(req, "student_update", { userId: user._id });

    res.status(200).json({
      success: true,
      message: "Screenshot uploaded successfully, waiting for manager review.",
      url: cloudinaryResponse.secure_url,
    });
  } catch (error) {
    console.error("Cloudinary Upload Error:", error);
    res.status(500).json({ message: "Server Error during upload" });
  }
};

// =====================================================
// MANAGER: approve / reject  { userId, status: "verified" | "rejected" }
// =====================================================
const verifyFeePayment = async (req, res) => {
  try {
    const { userId, status } = req.body;
    if (!isValidId(userId)) return res.status(400).json({ message: "Valid userId required" });
    if (!["verified", "rejected"].includes(status)) {
      return res.status(400).json({ message: "status must be 'verified' or 'rejected'" });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    user.feeStatus = status === "verified" ? "paid" : "unpaid";
    user.feePaymentStatus = status;
    user.feeVerifiedBy = req.user ? req.user._id : null;
    if (status === "verified") user.lastFeePaymentDate = new Date();
    await user.save();

    notifyAdmins(req, "fee_update", { userId: user._id });
    notifyAdmins(req, "student_update", { userId: user._id });
    if (req.io) {
      req.io.to(String(user._id)).emit("permissions_updated", {
        feeStatus: user.feeStatus,
        feePaymentStatus: user.feePaymentStatus,
      });
    }

    res.status(200).json({ success: true, message: `Fee status updated to ${status}` });
  } catch (error) {
    console.error("Verify Fee Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const getPendingFeeSubmissions = async (req, res) => {
  try {
    const students = await User.find({ feePaymentStatus: "pending_verification" })
      .select("name phone mode onlineSection feePaymentScreenshot feeSubmittedAt feePaymentStatus")
      .sort({ feeSubmittedAt: 1 })
      .lean();
    res.status(200).json({ success: true, students });
  } catch (error) {
    console.error("Get Pending Fees Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const getAllFeeHistory = async (req, res) => {
  try {
    const [totalStudents, totalPaid, historyRecords, students] = await Promise.all([
      User.countDocuments({ role: "student" }),
      User.countDocuments({ role: "student", feeStatus: "paid" }),
      FeeHistory.find({}).sort({ archivedAt: -1 }).lean(),
      User.find({ feePaymentStatus: { $in: ["verified", "rejected", "pending_verification"] } })
        .select("name phone mode onlineSection feePaymentScreenshot feeSubmittedAt feePaymentStatus lastFeePaymentDate")
        .sort({ updatedAt: -1 })
        .lean(),
    ]);

    const currentLiveSummary = {
      monthYear: monthKey(),
      totalStudents,
      totalPaid,
      totalUnpaid: totalStudents - totalPaid,
      isCurrentMonth: true,
    };

    res.status(200).json({
      success: true,
      students,
      currentMonth: currentLiveSummary,
      history: [currentLiveSummary, ...historyRecords],
    });
  } catch (error) {
    console.error("Get Fee History Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { uploadFeeScreenshot, verifyFeePayment, getPendingFeeSubmissions, getAllFeeHistory };
