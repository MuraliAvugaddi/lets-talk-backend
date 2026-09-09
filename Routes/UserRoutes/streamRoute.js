const express = require("express");
const router = express.Router();
//const { getStreamToken } = require("../../Controllers/UserContollers/streamController");
const { getStreamToken } = require("../../Controllers/UserContollers/streamController");

// POST /api/stream/token
router.post("/token", getStreamToken);

module.exports = router;