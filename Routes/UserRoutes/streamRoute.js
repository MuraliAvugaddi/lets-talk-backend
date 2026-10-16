const express = require("express");
const router = express.Router();
const { getStreamToken, prepareCall } = require("../../Controllers/UserContollers/streamController");
const { auth } = require("../../middleware/authMiddleware");

// POST /api/stream/token
router.post("/token", auth(), getStreamToken);

// POST /api/stream/prepare-call → { callId, started }
router.post("/prepare-call", auth(), prepareCall);

module.exports = router;
