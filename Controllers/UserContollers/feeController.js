const User = require("../../Models/users");
const FeeHistory = require("../../Models/feeHistory");
const { uploadBufferToCloudinary, deleteFromCloudinary } = require("../../utils/cloudinary");
const { monthKey } = require("../../utils/time");
const { isValidId, normLanguage } = require("../../utils/normalize");

const notifyAdmins = (req, event, payload) => {
  if (req.io) req.io.to("admin_room").emit(event, payload);
};

const anyOn = (m) => !!m && Object.values(typeof m.toObject === "function" ? m.toObject() : m).some((v) => v === true);

const isBoth = (v) => ["both", "all", "english+hindi", "english & hindi"].includes(String(v || "").trim().toLowerCase());

// Which course a fee is for: what the student picked (English / Hindi / Both), else guessed from their enabled stages
const feeLanguageOf = (user, picked) => {
  if (isBoth(picked)) return "Both";
  const lang = normLanguage(picked);
  if (lang) return lang;
  if (user.feeLanguage) return user.feeLanguage;
  if (anyOn(user.hindiAccess) && !anyOn(user.englishAccess)) return "Hindi";
  if (user.language === "Hindi" && !anyOn(user.englishAccess)) return "Hindi";
  return "English";
};

// The student's own id: from the login token, else (transition mode) from body/query
const studentIdOf = (req) => (req.user ? String(req.user._id) : String(req.body?.userId || req.query?.userId || ""));

const money = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const balanceOf = (user) => Math.max(money(user.feeAmountDue) - money(user.feeAmountPaid), 0);

const feeStatusView = (user) => ({
  feeStatus: user.feeStatus,
  feePaymentStatus: user.feePaymentStatus,
  feePaymentScreenshot: user.feePaymentScreenshot || "",
  feeSubmittedAt: user.feeSubmittedAt,
  feeLanguage: user.feeLanguage || "",
  lastFeePaymentDate: user.lastFeePaymentDate,
  // 💰 part payment
  feeAmountDue: money(user.feeAmountDue),
  feeAmountPaid: money(user.feeAmountPaid),
  feeBalance: balanceOf(user),
  feePayments: (user.feePayments || []).map((p) => ({ amount: p.amount, language: p.language, at: p.at })),
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
    if (user.isDropout) {
      return res.status(403).json({ message: "Your classes are paused, so no fee is due. Please contact the institute to rejoin." });
    }
    if (user.feeStatus === "paid" || user.feePaymentStatus === "verified") {
      return res.status(400).json({ message: "Your fee for this month is already verified." });
    }

    const cloudinaryResponse = await uploadBufferToCloudinary(req.file.buffer);
    // a screenshot of a part payment that was already accepted stays (it is in this month's record)
    const oldPublicId = user.feePaymentStatus === "partial" ? "" : user.feeScreenshotPublicId;

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
      "feeStatus feePaymentStatus feePaymentScreenshot feeSubmittedAt feeLanguage lastFeePaymentDate feeAmountDue feeAmountPaid feePayments"
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
    const hadPart = money(user.feeAmountPaid) > 0;
    user.feePaymentScreenshot = "";
    user.feeScreenshotPublicId = "";
    user.feePaymentStatus = hadPart ? "partial" : "not_submitted"; // part payment already received stays
    user.feeSubmittedAt = null;
    if (!hadPart) user.feeLanguage = "";
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
// MANAGER: approve / reject
//   { userId, status: "verified" | "rejected", amount?, totalFee? }
//   amount   = money received in THIS screenshot (e.g. 1500)
//   totalFee = this month's full fee (e.g. 2700, or 5400 for both courses)
//   amount + earlier parts < totalFee → "partial": student sees ₹ left + gets a notification
//   no amount → full payment (old admin app keeps working)
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

    const notify = require("../../utils/notify");
    let message = `Fee status updated to ${status}`;
    let partial = false;

    if (status === "rejected") {
      user.feeStatus = "unpaid";
      user.feePaymentStatus = "rejected";
    } else {
      const amount = money(req.body.amount);
      const hasAmount = req.body.amount !== undefined && req.body.amount !== null && req.body.amount !== "";
      if (hasAmount && !amount) return res.status(400).json({ message: "Enter the amount received (more than 0)." });

      const totalFee = money(req.body.totalFee) || money(user.feeAmountDue) || amount;
      const paidBefore = money(user.feeAmountPaid);
      const paidNow = hasAmount ? paidBefore + amount : Math.max(paidBefore, totalFee);

      if (hasAmount) {
        user.feePayments = [
          ...(user.feePayments || []),
          {
            amount,
            language: user.feeLanguage || "",
            screenshot: user.feePaymentScreenshot || "",
            at: new Date(),
            byName: req.user ? req.user.name || "" : "",
          },
        ];
      }
      user.feeAmountDue = totalFee;
      user.feeAmountPaid = paidNow;
      user.lastFeePaymentDate = new Date();

      if (hasAmount && totalFee > 0 && paidNow < totalFee) {
        // 💰 part payment
        partial = true;
        user.feeStatus = "unpaid";
        user.feePaymentStatus = "partial";
        message = `₹${amount} saved • ₹${totalFee - paidNow} left of ₹${totalFee}`;
      } else {
        user.feeStatus = "paid";
        user.feePaymentStatus = "verified";
        message = hasAmount ? `Fully paid • ₹${paidNow} of ₹${totalFee}` : "Payment approved";
      }
    }
    user.feeVerifiedBy = req.user ? req.user._id : null;
    await user.save();

    notifyAdmins(req, "fee_update", { userId: user._id });
    notifyAdmins(req, "student_update", { userId: String(user._id), feeStatus: user.feeStatus });
    if (req.io) {
      req.io.to(String(user._id)).emit("permissions_updated", {
        feeStatus: user.feeStatus,
        feePaymentStatus: user.feePaymentStatus,
      });
    }

    // 🔔
    if (status === "rejected") notify.feeRejected(user._id);
    else if (partial) notify.feePartial(user._id, money(req.body.amount), balanceOf(user), money(user.feeAmountDue));
    else notify.feeApproved(user._id);

    res.status(200).json({ success: true, message, ...feeStatusView(user) });
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
    feeAmountDue: money(s.feeAmountDue),
    feeAmountPaid: money(s.feeAmountPaid),
    feeBalance: balanceOf(s),
  }));

const getPendingFeeSubmissions = async (req, res) => {
  try {
    const students = await User.find({ feePaymentStatus: "pending_verification" })
      .select("name phone mode onlineSection language feeLanguage englishAccess hindiAccess feePaymentScreenshot feeSubmittedAt feePaymentStatus feeAmountDue feeAmountPaid feePayments")
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
    const [totalStudents, totalPaid, totalPartial, historyRecords, students] = await Promise.all([
      User.countDocuments({ role: "student", isDropout: { $ne: true } }),
      User.countDocuments({ role: "student", isDropout: { $ne: true }, feeStatus: "paid" }),
      User.countDocuments({ role: "student", isDropout: { $ne: true }, feeStatus: { $ne: "paid" }, feeAmountPaid: { $gt: 0 } }),
      FeeHistory.find({}).sort({ archivedAt: -1 }).lean(),
      User.find({ feePaymentStatus: { $in: ["verified", "rejected", "pending_verification", "partial"] } })
        .select("name phone mode onlineSection language feeLanguage englishAccess hindiAccess feePaymentScreenshot feeSubmittedAt feePaymentStatus lastFeePaymentDate feeAmountDue feeAmountPaid feePayments")
        .sort({ updatedAt: -1 })
        .lean(),
    ]);

    const currentLiveSummary = {
      monthYear: monthKey(),
      totalStudents,
      totalPaid,
      totalUnpaid: totalStudents - totalPaid,
      totalPartial,
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
  _internal: { feeLanguageOf, withLanguage, balanceOf },
};
