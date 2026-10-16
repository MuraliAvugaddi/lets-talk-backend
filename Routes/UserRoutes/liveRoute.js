const express = require("express");
const router = express.Router();
const { updateLink, deleteLink, getLink } = require("../../Controllers/UserContollers/liveController");
const { requireAuth } = require("../../middleware/authMiddleware");

// Trainers start/end their own live class, so they must be able to set/clear the live link.
const STAFF = ["teacher", "manager", "admin"];

router.post("/admin/update", requireAuth(...STAFF), updateLink);
router.delete("/admin/delete", requireAuth(...STAFF), deleteLink);
router.get("/user/get", getLink);

module.exports = router;
