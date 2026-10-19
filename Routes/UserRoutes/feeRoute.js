const express = require("express");
const router = express.Router();
const multer = require("multer");
const {
  uploadFeeScreenshot,
  deleteMyFeeScreenshot,
  getMyFeeStatus,
  verifyFeePayment,
  getPendingFeeSubmissions,
  getAllFeeHistory,
} = require("../../Controllers/UserContollers/feeController");
const { auth, requireAuth } = require("../../middleware/authMiddleware");

const ADMIN = ["manager", "admin"];
const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif)$/i;

// 5 MB, images only — a large upload can no longer crash the server.
// Phones often send the file as "application/octet-stream" (Flutter's default),
// so the file name extension is accepted too. (This was the "Failed to upload screenshot" bug.)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const type = String(file.mimetype || "");
    if (/^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(type) || IMAGE_EXT.test(file.originalname || "")) {
      return cb(null, true);
    }
    const err = new Error("Only image files (JPG, PNG, WEBP, HEIC) are allowed");
    err.status = 400;
    cb(err);
  },
});

// Friendly errors (shown to the student in the app)
const uploadScreenshot = (req, res, next) =>
  upload.single("screenshot")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ message: "Screenshot is too large (max 5 MB)." });
    return res.status(err.status || 400).json({ message: err.message || "Upload error" });
  });

// Student
router.post("/upload-fee-screenshot", auth(), uploadScreenshot, uploadFeeScreenshot);
router.get("/my-status", auth(), getMyFeeStatus);
router.delete("/my-screenshot", auth(), deleteMyFeeScreenshot);

// Admin
router.post("/verify-fee", requireAuth(...ADMIN), verifyFeePayment);
router.get("/pending-fees", auth(...ADMIN), getPendingFeeSubmissions);
router.get("/history", auth(...ADMIN), getAllFeeHistory);

module.exports = router;
