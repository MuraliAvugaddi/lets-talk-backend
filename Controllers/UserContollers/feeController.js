const User = require("../../Models/users");
const FeeHistory = require("../../Models/feeHistory");
const { uploadBufferToCloudinary, deleteFromCloudinary } = require("../../utils/cloudinary");
const { monthKey } = require("../../utils/time");
const { isValidId, normLanguage } = require("../../utils/normalize");

const notifyAdmins = (req, event, payload) => {
  if (req.io) req.io.to("admin_room").emit(event, payload);
};

const anyOn = (m) => !!m && Object.values(typeof m.toObject === "function" ? m.toObject() : m).some((v) => v === true);

// Which course a fee is for: what the student picked, else guessed from their enabled stages
const feeLanguageOf = (user, picked) => {
  const lang = normLanguage(picked);
  if (lang) return lang;
  if (user.feeLanguage) return user.feeLanguage;
  if (anyOn(user.hindiAccess) && !anyOn(user.englishAccess)) return "Hindi";
  if (user.language === "Hindi" && !anyOn(user.englishAccess)) return "Hindi";
  return "English";
};

// The student's own id: from the login token, else (transition mode) from body/query
const studentIdOf = (req) => (req.user ? String(req.user._id) : String(req.body?.userId || req.query?.userId || ""));

const feeStatusView = (user) => ({
  feeStatus: user.feeStatus,
  feePaymentStatus: user.feePaymentStatus,
  feePaymentScreenshot: user.feePaymentScreenshot || "",
  feeSubmittedAt: user.feeSubmittedAt,
  feeLanguage: user.feeLanguage || "",
  lastFeePaymentDate: user.lastFeePaymentDate,
  canDelete: ["pending_verification", "rejected"].includes(user.feePaymentStatus) && !!user.feePaymentScreenshot,
});

// =====================================================
// STUDENT: upload payment screenshot
// POST /api/fee/upload-fee-screenshot  (multipart: screenshot, userId, language = English | Hindi)
// Uploading again while "waiting for verification" replaces the old screenshot.
// =====================================================
const uploadFeeScreenshot = async (req, res) => {
  try {
    const userId = studentIdOf(req);
    if (!isValidId(userId)) return res.status(400).json({ message: "Valid userId required" });
    if (!req.file) return res.status(400).json({ message: "No screenshot file uploaded" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.feeStatus === "paid" || user.feePaymentStatus === "verified") {
      return res.status(400).json({ message: "Your fee for this month is already verified." });
    }

    const cloudinaryResponse = await uploadBufferToCloudinary(req.file.buffer);
    const oldPublicId = user.feeScreenshotPublicId;

    user.feePaymentScreenshot = cloudinaryResponse.secure_url;
    user.feeScreenshotPublicId = cloudinaryResponse.public_id || "";
    user.feePaymentStatus = "pending_verification";
    user.feeSubmittedAt = new Date();
    user.feeLanguage = feeLanguageOf(user, req.body.language);
    await user.save();

    // replaced screenshot → remove the old file
    if (oldPublicId && oldPublicId !== user.feeScreenshotPublicId) deleteFromCloudinary(oldPublicId, "image");

    notifyAdmins(req, "fee_update", { userId: user._id });
    notifyAdmins(req, "student_update", { userId: String(user._id), feeStatus: user.feeStatus });

    res.status(200).json({
      success: true,
      message: "Screenshot uploaded successfully, waiting for manager review.",
      url: cloudinaryResponse.secure_url,
      ...feeStatusView(user),
    });
  } catch (error) {
    console.error("Cloudinary Upload Error:", error);
    const why = error && error.message ? error.message : "unknown";
    res.status(500).json({ message: `Upload failed on the server (${why}). Please try again.` });
  }
};

// =====================================================
// STUDENT: my fee status  GET /api/fee/my-status?userId=
// =====================================================
const getMyFeeStatus = async (req, res) => {
  try {
    const userId = studentIdOf(req);
    if (!isValidId(userId)) return res.status(400).json({ message: "Valid userId required" });
    const user = await User.findById(userId).select(
      "feeStatus feePaymentStatus feePaymentScreenshot feeSubmittedAt feeLanguage lastFeePaymentDate"
    );
    if (!user) return res.status(404).json({ message: "User not found" });
    res.status(200).json({ success: true, ...feeStatusView(user) });
  } catch (error) {
    console.error("My fee status error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// STUDENT: delete a wrong screenshot  DELETE /api/fee/my-screenshot?userId=
// Only while it is waiting for verification (or was rejected).
// =====================================================
const deleteMyFeeScreenshot = async (req, res) => {
  try {
    const userId = studentIdOf(req);
    if (!isValidId(userId)) return res.status(400).json({ message: "Valid userId required" });
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!["pending_verification", "rejected"].includes(user.feePaymentStatus) || !user.feePaymentScreenshot) {
      return res.status(400).json({
        message: user.feePaymentStatus === "verified" ? "This payment is already verified." : "No screenshot to delete.",
      });
    }

    const publicId = user.feeScreenshotPublicId;
    user.feePaymentScreenshot = "";
    user.feeScreenshotPublicId = "";
    user.feePaymentStatus = "not_submitted";
    user.feeSubmittedAt = null;
    user.feeLanguage = "";
    await user.save();
    if (publicId) deleteFromCloudinary(publicId, "image");

    notifyAdmins(req, "fee_update", { userId: user._id });
    res.status(200).json({ success: true, message: "Screenshot deleted.", ...feeStatusView(user) });
  } catch (error) {
    console.error("Delete fee screenshot error:", error);
    res.status(500).json({ message: "Server Error" });
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
    notifyAdmins(req, "student_update", { userId: String(user._id), feeStatus: user.feeStatus });
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

// Every row gets feeLanguage (old uploads have none → guessed from enabled stages)
const withLanguage = (students) =>
  students.map(({ englishAccess, hindiAccess, ...s }) => ({
    ...s,
    feeLanguage: feeLanguageOf({ ...s, englishAccess, hindiAccess }, s.feeLanguage),
  }));

const getPendingFeeSubmissions = async (req, res) => {
  try {
    const students = await User.find({ feePaymentStatus: "pending_verification" })
      .select("name phone mode onlineSection language feeLanguage englishAccess hindiAccess feePaymentScreenshot feeSubmittedAt feePaymentStatus")
      .sort({ feeSubmittedAt: 1 })
      .lean();
    res.status(200).json({ success: true, students: withLanguage(students) });
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
        .select("name phone mode onlineSection language feeLanguage englishAccess hindiAccess feePaymentScreenshot feeSubmittedAt feePaymentStatus lastFeePaymentDate")
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
      students: withLanguage(students),
      currentMonth: currentLiveSummary,
      history: [currentLiveSummary, ...historyRecords],
    });
  } catch (error) {
    console.error("Get Fee History Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = {
  uploadFeeScreenshot,
  getMyFeeStatus,
  deleteMyFeeScreenshot,
  verifyFeePayment,
  getPendingFeeSubmissions,
  getAllFeeHistory,
  _internal: { feeLanguageOf, withLanguage },
};
