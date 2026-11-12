const express = require("express");
const router = express.Router();
const { prepareCall } = require("../../Controllers/UserContollers/streamController");
const rtc = require("../../Controllers/UserContollers/rtcController");
const { requireAuth } = require("../../middleware/authMiddleware");
const { STAFF_ROLES } = require("../../utils/normalize");

const viaLiveKit = (req, res, next) => {
  req.rtc = "livekit";
  next();
};

// 🎧 LiveKit audio classes — new app versions only (they always send the login token)
router.post("/prepare-call", requireAuth(), viaLiveKit, prepareCall);
router.post("/token", requireAuth(), rtc.rtcToken);
router.post("/room-token", requireAuth(), rtc.roomToken);

// 👀 admin / manager quietly listens to any running class (hidden, cannot speak)
router.get("/live-rooms", requireAuth("admin", "manager"), rtc.liveRooms);
router.post("/observe-token", requireAuth("admin", "manager"), rtc.observeToken);
router.post("/observe-speak", requireAuth("admin", "manager"), rtc.observeSpeak); // 🎙 admin talks in the class
router.get("/room-check", requireAuth("admin", "manager"), rtc.roomCheck); // 🔍 who is sending sound

// trainer / admin controls
router.post("/room/state", requireAuth(...STAFF_ROLES), rtc.setState);
router.post("/room/kick", requireAuth(...STAFF_ROLES), rtc.kick);
router.post("/room/mute", requireAuth(...STAFF_ROLES), rtc.mute);
router.post("/room/end", requireAuth(...STAFF_ROLES), rtc.end);

module.exports = router;