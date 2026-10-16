const express = require("express");
const router = express.Router();
const multer = require("multer");
const {
  uploadFeeScreenshot,
  verifyFeePayment,
  getPendingFeeSubmissions,
  getAllFeeHistory,
} = require("../../Controllers/UserContollers/feeController");
const { auth, requireAuth } = require("../../middleware/authMiddleware");

const ADMIN = ["manager", "admin"];

// 5 MB, images only — a large upload can no longer crash the server
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(file.mimetype)) return cb(null, true);
    const err = new Error("Only image files (JPG, PNG, WEBP, HEIC) are allowed");
    err.status = 400;
    cb(err);
  },
});

router.post("/upload-fee-screenshot", auth(), upload.single("screenshot"), uploadFeeScreenshot);
router.post("/verify-fee", requireAuth(...ADMIN), verifyFeePayment);
router.get("/pending-fees", auth(...ADMIN), getPendingFeeSubmissions);
router.get("/history", auth(...ADMIN), getAllFeeHistory);

module.exports = router;
