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
  onlineClassHeartbeat,
  getAttendanceSheet,
  getAllStudentsFiltered,
  getMyAttendance,
  autoMarkAbsent,
} = require("../../Controllers/UserContollers/attendanceController");

// --- 4. MIDDLEWARE ---
const { protect } = require("../../middleware/authMiddleware");

// ==============================
//           AUTH ROUTES
// ==============================
router.post("/register", registerUser);
router.post("/login", loginUser);
router.post("/reset-password", resetPassword);
router.get("/profile", protect, getUserProfile);

// ==============================
//        ADMIN USER ROUTES
// ==============================
router.get("/users", protect, getAllUsers);
router.put("/update-access", protect, updateUserAccess);
router.delete("/users/:id", protect, deleteUser);
router.get("/admin/users-by-stage", protect, getUsersByStage);
router.get("/admin/all-students", getAllStudentsFiltered);

// ==============================
//      NOTIFICATION ROUTES
// ==============================
router.post("/admin/notification", protect, setNotification);
router.delete("/admin/notification", protect, deleteNotification);
router.get("/user/notification", getNotification);

// ==============================
//       ATTENDANCE ROUTES
// ==============================
router.post("/user/mark-attendance", markAttendance);
router.post("/user/join-online-class", joinOnlineClass);
router.post("/user/online-heartbeat", onlineClassHeartbeat);
router.get("/user/my-attendance", getMyAttendance);
router.get("/admin/attendance", getAttendanceSheet);
router.post("/admin/auto-absent", autoMarkAbsent);

module.exports = router;