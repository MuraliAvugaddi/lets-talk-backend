const express = require("express");
const router = express.Router();
const multer = require("multer");
const {
  createPromo,
  listPromos,
  updatePromo,
  deletePromo,
  getActivePromos,
} = require("../../Controllers/UserContollers/promoController");
const { auth, requireAuth } = require("../../middleware/authMiddleware");

const ADMIN = ["manager", "admin"];

const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|gif)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|3gp|mkv)$/i;

// image (max 10 MB, checked in the controller) + video (max 100 MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 2 },
  fileFilter: (req, file, cb) => {
    const name = file.originalname || "";
    const type = String(file.mimetype || "");
    if (file.fieldname === "image" && (type.startsWith("image/") || IMAGE_EXT.test(name))) return cb(null, true);
    if (file.fieldname === "video" && (type.startsWith("video/") || VIDEO_EXT.test(name))) return cb(null, true);
    const err = new Error(
      file.fieldname === "video"
        ? "Reel must be a video file (MP4, MOV, WEBM)"
        : "Poster must be an image file (JPG, PNG, WEBP)"
    );
    err.status = 400;
    cb(err);
  },
}).fields([
  { name: "image", maxCount: 1 },
  { name: "video", maxCount: 1 },
]);

// Friendly upload errors instead of the generic "max 5 MB"
const uploadMedia = (req, res, next) =>
  upload(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ message: "File too large. Image max 10 MB, reel max 100 MB." });
    }
    return res.status(err.status || 400).json({ message: err.message || "Upload error" });
  });

// Student home screen (no login needed — posters are public)
router.get("/active", getActivePromos);

// Admin
router.get("/", auth(...ADMIN), listPromos);
router.post("/", requireAuth(...ADMIN), uploadMedia, createPromo);
router.patch("/:id", requireAuth(...ADMIN), updatePromo);
router.delete("/:id", requireAuth(...ADMIN), deletePromo);

module.exports = router;
