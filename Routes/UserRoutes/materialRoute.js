const express = require("express");
const router = express.Router();
const multer = require("multer");
const {
  listMaterials,
  uploadMaterial,
  renameMaterial,
  deleteMaterial,
} = require("../../Controllers/UserContollers/materialController");
const { auth, requireAuth } = require("../../middleware/authMiddleware");

const ADMIN = ["manager", "admin"];

// 📚 one PDF (max 40 MB, compressed after upload)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const name = file.originalname || "";
    const type = String(file.mimetype || "");
    if (type === "application/pdf" || /\.pdf$/i.test(name) || type === "application/octet-stream") return cb(null, true);
    const err = new Error("Please choose a PDF file.");
    err.status = 400;
    cb(err);
  },
}).single("pdf");

const uploadPdf = (req, res, next) =>
  upload(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ message: "PDF too large (max 40 MB)." });
    return res.status(err.status || 400).json({ message: err.message || "Upload error" });
  });

// students, trainers, admin (logged in)
router.get("/", auth(), listMaterials);

// admin / manager
router.post("/", requireAuth(...ADMIN), uploadPdf, uploadMaterial);
router.patch("/:id", requireAuth(...ADMIN), renameMaterial);
router.delete("/:id", requireAuth(...ADMIN), deleteMaterial);

module.exports = router;
