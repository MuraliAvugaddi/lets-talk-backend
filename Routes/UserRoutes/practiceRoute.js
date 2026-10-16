const express = require("express");
const router = express.Router();
const { markPractice, listPractice } = require("../../Controllers/UserContollers/practiceController");
const { requireAuth } = require("../../middleware/authMiddleware");

// Trainers mark practice from the live classroom; admins read it.
const STAFF = ["teacher", "manager", "admin"];

router.post("/mark", requireAuth(...STAFF), markPractice);
router.get("/list", requireAuth(...STAFF), listPractice);

module.exports = router;
