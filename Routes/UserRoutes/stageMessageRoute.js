const express = require("express");
const router = express.Router();
const { listMessages, sendMessage, deleteMessage } = require("../../Controllers/UserContollers/stageMessageController");
const { requireAuth } = require("../../middleware/authMiddleware");

const ADMIN = ["manager", "admin"];

// students (their own messages) + admin (all)
router.get("/", requireAuth(), listMessages);

// admin / manager
router.post("/", requireAuth(...ADMIN), sendMessage);
router.delete("/:id", requireAuth(...ADMIN), deleteMessage);

module.exports = router;
