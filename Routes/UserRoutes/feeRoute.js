const express = require("express");
const router = express.Router();
const multer = require("multer");
const { 
  uploadFeeScreenshot, 
  verifyFeePayment, 
  getPendingFeeSubmissions,
  getAllFeeHistory 
} = require("../../Controllers/UserContollers/feeController");

const upload = multer({ storage: multer.memoryStorage() });

router.post("/upload-fee-screenshot", upload.single("screenshot"), uploadFeeScreenshot);
router.post("/verify-fee", verifyFeePayment);
router.get("/pending-fees", getPendingFeeSubmissions);
router.get("/history", getAllFeeHistory); // 🚀 Added Accounting History Endpoint

module.exports = router;