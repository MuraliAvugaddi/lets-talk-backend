const express = require("express");
const router = express.Router();

// --- 1. AUTH CONTROLLERS ---
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
} = require("../../Controllers/UserContollers/authController");

// --- 2. NOTIFICATION CONTROLLERS ---
const {
  setNotification,
  deleteNotification,
  getNotification,
} = require("../../Controllers/UserContollers/notificationController");

// --- 3. ATTENDANCE CONTROLLERS ---
const {
  markAttendance,
  joinOnlineClass,
  syncOnlineClass,
  leaveOnlineClass,
  getAttendanceSheet,
  getAllStudentsFiltered,
  getTrainerClassroomRoster,
  getMyAttendance,
  autoMarkAbsent,
} = require("../../Controllers/UserContollers/attendanceController");

// --- 4. FEEDBACK CONTROLLERS ---
const {
  submitFeedback,
  getAllFeedbacks,
  deleteFeedback,
} = require("../../Controllers/UserContollers/feedbackController");

// --- 5. MIDDLEWARE ---
const { protect } = require("../../middleware/authMiddleware");

// ==============================
//        AUTH ROUTES
// ==============================
router.post("/register", registerUser);
router.post("/login", loginUser);
router.post("/reset-password", resetPassword);
router.get("/profile", protect, getUserProfile);

// ==============================
//       ADMIN USER ROUTES
// ==============================
router.get("/users", protect, getAllUsers);
router.get("/admin/all-students", getAllUsers);
router.put("/update-access", protect, updateUserAccess);
router.put("/admin/update-student-status", protect, updateStudentStatus);
router.delete("/users/:id", protect, deleteUser);
router.get("/admin/users-by-stage", protect, getUsersByStage);
router.get("/admin/teachers", getAllTeachersFiltered);

// ==============================
//       NOTIFICATION ROUTES
// ==============================
router.post("/admin/notification", protect, setNotification);
router.delete("/admin/notification", protect, deleteNotification);
router.get("/user/notification", getNotification);

// ==============================
//       ATTENDANCE ROUTES
// ==============================
router.post("/user/mark-attendance", markAttendance);
router.post("/user/join-online-class", joinOnlineClass);
router.post("/user/sync-online-class", syncOnlineClass);
router.post("/user/leave-online-class", leaveOnlineClass);

router.get("/admin/trainer-roster", getTrainerClassroomRoster);
router.get("/user/my-attendance", getMyAttendance);
router.get("/admin/attendance", getAttendanceSheet);
router.post("/admin/auto-absent", autoMarkAbsent);

// ==============================
//        FEEDBACK ROUTES
// ==============================
router.post("/user/feedback", submitFeedback);
router.get("/admin/feedbacks", protect, getAllFeedbacks);
router.delete("/admin/feedbacks/:id", protect, deleteFeedback);

// 🛑 CRITICAL: Must export the router, NOT an object of functions!
module.exports = router;