const express = require("express");
const router = express.Router();
const { listHolidays, addHolidays, removeHoliday } = require("../../Controllers/UserContollers/holidayController");
const { getAppVersion, setAppVersion } = require("../../Controllers/UserContollers/appVersionController");

const {
  registerUser,
  loginUser,
  resetPassword,
  getUserProfile,
  getAllUsers,
  getStudentById,
  updateUserAccess,
  deleteUser,
  getUsersByStage,
  updateStudentStatus,
  getAllTeachersFiltered,
  getBatches,
  updateMyBatchTime,
  savePushToken,
  removePushToken,
} = require("../../Controllers/UserContollers/authController");

const {
  setNotification,
  deleteNotification,
  getNotification,
} = require("../../Controllers/UserContollers/notificationController");

const {
  markAttendance,
  joinOnlineClass,
  syncOnlineClass,
  leaveOnlineClass,
  getAttendanceSheet,
  getTrainerClassroomRoster,
  getMyAttendance,
  autoMarkAbsent,
  getTrainerAttendance,
  getBatchVisitors,
  getBatchSummary,
} = require("../../Controllers/UserContollers/attendanceController");

const {
  submitFeedback,
  getAllFeedbacks,
  deleteFeedback,
} = require("../../Controllers/UserContollers/feedbackController");

const { getAttendanceReport } = require("../../Controllers/UserContollers/reportController");
const { getLeaderboard, getRatingLeaderboard } = require("../../Controllers/UserContollers/leaderboardController");
const { getBestStudents } = require("../../Controllers/UserContollers/bestStudentController");
const { getClassLoad } = require("../../Controllers/UserContollers/classLoadController");
const { changeMode, endTempMode, listModeChanges } = require("../../Controllers/UserContollers/modeChangeController");
const multer = require("multer");
const {
  updateMyProfile,
  uploadMyPhoto,
  removeMyPhoto,
  changeMyPhone,
  updateStaff,
} = require("../../Controllers/UserContollers/profileController");
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok =
      /^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(String(file.mimetype || "")) ||
      /\.(jpe?g|png|webp|heic|heif)$/i.test(file.originalname || "");
    if (ok) return cb(null, true);
    const err = new Error("Only photos (JPG, PNG, WEBP, HEIC) are allowed");
    err.status = 400;
    cb(err);
  },
});
const takePhoto = (req, res, next) =>
  photoUpload.single("photo")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ message: "Photo is too large (max 5 MB)" });
    return res.status(err.status || 400).json({ message: err.message || "Upload error" });
  });
const {
  markDropout,
  rejoinDropout,
  addDropoutNote,
  listDropouts,
  dropoutDetail,
} = require("../../Controllers/UserContollers/dropoutController");
const { promoteCandidates, promoteStudents } = require("../../Controllers/UserContollers/promotionController");

const { auth, requireAuth } = require("../../middleware/authMiddleware");
const { loginLimiter, resetLimiter, registerLimiter, otpLimiter, otpVerifyLimiter } = require("../../middleware/rateLimit");
const { sendOtp, verifyOtp } = require("../../Controllers/UserContollers/otpController");

// requireAuth  = token always required
// auth         = token required once ENFORCE_AUTH=true (transition mode before that)
const ADMIN = ["manager", "admin"];
const STAFF = ["teacher", "manager", "admin"];

// ==============================
//        AUTH
// ==============================
// 🔐 Phone OTP by SMS (MSG91) — signup + forgot password
router.post("/otp/send", otpLimiter, sendOtp);
router.post("/otp/verify", otpVerifyLimiter, verifyOtp);
router.post("/register", registerLimiter, registerUser); // staff roles need an admin token (checked inside)
router.post("/login", loginLimiter, loginUser);
router.post("/reset-password", resetLimiter, resetPassword); // needs Firebase OTP idToken
router.get("/profile", requireAuth(), getUserProfile);
// 👤 edit own profile (name, photo, phone with OTP). Online/offline is admin-only.
router.put("/user/profile", requireAuth(), updateMyProfile);
router.post("/user/profile-photo", requireAuth(), takePhoto, uploadMyPhoto);
router.delete("/user/profile-photo", requireAuth(), removeMyPhoto);
router.post("/user/change-phone", requireAuth(), changeMyPhone);
router.post("/user/push-token", requireAuth(), savePushToken); // 🔔
router.delete("/user/push-token", requireAuth(), removePushToken);

// ==============================
//        BATCH TIMINGS
// ==============================
router.get("/batches", getBatches);
router.put("/user/batch-time", requireAuth("student"), updateMyBatchTime);

// ==============================
//        USERS (admin)
// ==============================
router.get("/users", requireAuth(...ADMIN), getAllUsers);
router.get("/admin/all-students", auth(...ADMIN), getAllUsers);
router.get("/admin/student/:id", auth(...ADMIN), getStudentById); // one student (live Student Control screen)
router.put("/update-access", requireAuth(...ADMIN), updateUserAccess);
router.put("/admin/update-student-status", requireAuth(...ADMIN), updateStudentStatus);
// 🔁 online ↔ offline for 1 day / 2 days / 1 week / permanent
router.post("/admin/change-mode", requireAuth(...ADMIN), changeMode);
router.post("/admin/change-mode/end", requireAuth(...ADMIN), endTempMode);
router.get("/admin/mode-changes", requireAuth(...ADMIN), listModeChanges);
// 🚪 dropouts: mark (live class off, material stays open) → principal sees reason, fees, attendance → call → rejoin
router.post("/admin/dropout", requireAuth(...ADMIN), markDropout);
router.post("/admin/dropout/rejoin", requireAuth(...ADMIN), rejoinDropout);
router.post("/admin/dropout/note", requireAuth(...ADMIN), addDropoutNote);
router.get("/admin/dropouts", requireAuth(...ADMIN), listDropouts);
router.get("/admin/dropout", requireAuth(...ADMIN), dropoutDetail);
// 🎓 promote: old stage → finished (material only), next stage → current (live class)
router.get("/admin/promote/candidates", requireAuth(...ADMIN), promoteCandidates);
router.post("/admin/promote", requireAuth(...ADMIN), promoteStudents);
router.delete("/users/:id", requireAuth(), deleteUser); // students: self only (checked inside)
router.get("/admin/users-by-stage", auth(...STAFF), getUsersByStage);
router.get("/admin/teachers", auth(...ADMIN), getAllTeachersFiltered);
router.put("/admin/staff/:id", requireAuth(...ADMIN), updateStaff); // ✏️ edit trainer / manager
router.get("/admin/class-load", auth(...ADMIN), getClassLoad); // students per stage / section / timing

// ==============================
//        NOTIFICATIONS
// ==============================
router.post("/admin/notification", requireAuth(...ADMIN), setNotification);
router.delete("/admin/notification", requireAuth(...ADMIN), deleteNotification);
router.get("/admin/notification", getNotification);
router.get("/user/notification", getNotification);

// ==============================
//        ATTENDANCE
// ==============================
router.post("/user/mark-attendance", auth(), markAttendance);
router.post("/user/join-online-class", auth(), joinOnlineClass);
router.post("/user/sync-online-class", auth(), syncOnlineClass);
router.post("/user/leave-online-class", auth(), leaveOnlineClass);
router.get("/user/my-attendance", auth(), getMyAttendance);

router.get("/admin/trainer-roster", auth(...STAFF), getTrainerClassroomRoster);
router.get("/admin/attendance", auth(...STAFF), getAttendanceSheet);
router.get("/admin/batch-visitors", auth(...STAFF), getBatchVisitors); // joined outside own batch
router.get("/admin/batch-summary", auth(...STAFF), getBatchSummary); // per-timing present/late/absent/other
router.post("/admin/auto-absent", requireAuth("admin"), autoMarkAbsent);
router.get("/admin/trainer-attendance", auth(...STAFF), getTrainerAttendance); // morning + afternoon per trainer

// ==============================
//        🏖 HOLIDAYS
// ==============================
router.get("/admin/holidays", auth(), listHolidays); // apps may show "Tomorrow: Dasara holiday"
router.post("/admin/holidays", requireAuth(...ADMIN), addHolidays);
router.delete("/admin/holidays/:id", requireAuth(...ADMIN), removeHoliday);
// ==============================
//        📲 APP UPDATE MESSAGE
// ==============================
router.get("/app-version", getAppVersion);
router.put("/admin/app-version", requireAuth(...ADMIN), setAppVersion);

router.get("/attendance-rules", (req, res) => res.status(200).json(require("../../utils/attendanceRules").rulesSummary()));

// Monthly calendar + yearly graph. Admin/manager: any ?userId=. Others: own report only.
router.get("/attendance-report", requireAuth(), getAttendanceReport);

// Best trainer / best student of the month or year (everyone logged in; phones only for admins)
router.get("/leaderboard", requireAuth(), getLeaderboard);
router.get("/leaderboard/ratings", requireAuth(), getRatingLeaderboard); // ⭐ top rated (practice stars)
router.get("/leaderboard/best-students", requireAuth(), getBestStudents); // 🏆 best student per class + per language

// ==============================
//        FEEDBACK
// ==============================
router.post("/user/feedback", auth(), submitFeedback);
router.get("/admin/feedbacks", requireAuth(...ADMIN), getAllFeedbacks);
router.delete("/admin/feedbacks/:id", requireAuth(...ADMIN), deleteFeedback);

module.exports = router;
