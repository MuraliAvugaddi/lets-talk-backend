const express = require("express");
const router = express.Router();
const { markPractice, ratePractice, listPractice } = require("../../Controllers/UserContollers/practiceController");
const { requireAuth } = require("../../middleware/authMiddleware");

// Trainers mark practice from the live classroom; admins read it.
const STAFF = ["teacher", "manager", "admin"];

router.post("/mark", requireAuth(...STAFF), markPractice);
router.post("/rate", requireAuth(...STAFF), ratePractice); // ⭐ 1–5 after "Mark practiced"
router.get("/list", requireAuth(...STAFF), listPractice);

module.exports = router;
