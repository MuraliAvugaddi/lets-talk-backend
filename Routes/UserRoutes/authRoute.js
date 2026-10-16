const express = require("express");
const router = express.Router();

const {
  registerUser,
  loginUser,
  resetPassword,
  getUserProfile,
  getAllUsers,
  updateUserAccess,
  deleteUser,
  getUsersByStage,
  updateStudentStatus,
  getAllTeachersFiltered,
  getBatches,
  updateMyBatchTime,
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
  getBatchVisitors,
} = require("../../Controllers/UserContollers/attendanceController");

const {
  submitFeedback,
  getAllFeedbacks,
  deleteFeedback,
} = require("../../Controllers/UserContollers/feedbackController");

const { getAttendanceReport } = require("../../Controllers/UserContollers/reportController");
const { getLeaderboard } = require("../../Controllers/UserContollers/leaderboardController");

const { auth, requireAuth } = require("../../middleware/authMiddleware");
const { loginLimiter, resetLimiter, registerLimiter } = require("../../middleware/rateLimit");

// requireAuth  = token always required
// auth         = token required once ENFORCE_AUTH=true (transition mode before that)
const ADMIN = ["manager", "admin"];
const STAFF = ["teacher", "manager", "admin"];

// ==============================
//        AUTH
// ==============================
router.post("/register", registerLimiter, registerUser); // staff roles need an admin token (checked inside)
router.post("/login", loginLimiter, loginUser);
router.post("/reset-password", resetLimiter, resetPassword); // needs Firebase OTP idToken
router.get("/profile", requireAuth(), getUserProfile);

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
router.put("/update-access", requireAuth(...ADMIN), updateUserAccess);
router.put("/admin/update-student-status", requireAuth(...ADMIN), updateStudentStatus);
router.delete("/users/:id", requireAuth(), deleteUser); // students: self only (checked inside)
router.get("/admin/users-by-stage", auth(...STAFF), getUsersByStage);
router.get("/admin/teachers", auth(...ADMIN), getAllTeachersFiltered);

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
router.post("/admin/auto-absent", requireAuth("admin"), autoMarkAbsent);

// Monthly calendar + yearly graph. Admin/manager: any ?userId=. Others: own report only.
router.get("/attendance-report", requireAuth(), getAttendanceReport);

// Best trainer / best student of the month or year (everyone logged in; phones only for admins)
router.get("/leaderboard", requireAuth(), getLeaderboard);

// ==============================
//        FEEDBACK
// ==============================
router.post("/user/feedback", auth(), submitFeedback);
router.get("/admin/feedbacks", requireAuth(...ADMIN), getAllFeedbacks);
router.delete("/admin/feedbacks/:id", requireAuth(...ADMIN), deleteFeedback);

module.exports = router;
