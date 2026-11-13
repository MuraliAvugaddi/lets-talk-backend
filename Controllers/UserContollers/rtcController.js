// =====================================================
// 🎧 /api/rtc — LiveKit audio classes (new app versions)
//
//   POST /api/rtc/prepare-call   same as before: server decides the class
//   POST /api/rtc/token          kept for old "prewarm" code (nothing to fetch now)
//   POST /api/rtc/room-token     { room } → { token, url } to join that class
//   POST /api/rtc/room/state     { room, custom }  trainer: mic lock + practice
//   POST /api/rtc/room/kick      { room, userId }  trainer: remove a student
//   POST /api/rtc/room/mute      { room, userIds } or { room, all: true }
//   POST /api/rtc/room/end       { room }          end the class for everyone
// =====================================================
const lk = require("../../utils/livekit");
const { getModes, rainCovers } = require("../../utils/classMode");
const { dateKey } = require("../../utils/time");
const { STAFF_ROLES, normSection } = require("../../utils/normalize");
const { effectiveSection } = require("./sectionMergeController");

const isStaff = (u) => !!u && STAFF_ROLES.includes(u.role);
const { liveBlockReason } = require("../../utils/stageAccess");
// english_stage2_secA_… / hindi_stage1_… / offline_english_stage3_… → language + stage of the room
const roomStage = (room) => {
  const m = room.match(/^(?:offline_)?(english|hindi)_(stage\d)_/);
  return m ? { language: m[1] === "hindi" ? "Hindi" : "English", stage: m[2] } : null;
};
const todayTag = () => dateKey().split("-").reverse().join(""); // YYYYMMDD (IST)
const ROOM_RE = /^[a-z0-9_]{5,120}$/;

/** May this student join this room today? (staff: any room) */
const mayJoin = async (user, room) => {
  if (isStaff(user)) return true;
  if (!ROOM_RE.test(room) || !room.includes(`_${todayTag()}_`)) return false;

  if (room.startsWith("assembly_")) return !liveBlockReason(user, "English", "stage1", { assembly: true }) && !!(await getModes()).assembly;
  // 🎓 finished stage / dropout → no live class (study material only)
  const rs = roomStage(room);
  if (rs && liveBlockReason(user, rs.language, rs.stage)) return false;
  if (room.startsWith("offline_")) {
    // only the stages the admin moved online today
    if (user.mode !== "offline") return false;
    const st = (room.match(/^offline_[a-z]+_(stage\d)_/) || [])[1];
    const rain = (await getModes()).rain;
    return !rain || rainCovers(rain, st); // switched off meanwhile → let the running class finish
  }
  if (room.startsWith("hindi_")) return true;

  const m = room.match(/^english_(stage\d)_sec([a-z0-9]+)_/);
  if (!m) return false;
  const own = normSection(user.onlineSection);
  if (own === "None") return true; // no section set yet → old behaviour (any English class of the day)
  if (m[2] === own.toLowerCase()) return true;
  const eff = await effectiveSection(m[1], own); // Section B merged into A → may join A
  return m[2] === String(eff.section).toLowerCase();
};

const fail = (res, e, msg) => {
  console.error(`RTC ${msg}:`, e && e.message ? e.message : e);
  res.status(502).json({ error: msg });
};

// Old prewarm code asks for a "Stream token" — LiveKit needs none up front
const rtcToken = (req, res) =>
  res.status(200).json({ token: "livekit", apiKey: "livekit", userId: String(req.user._id), rtc: "livekit" });

const roomToken = async (req, res) => {
  try {
    if (lk.provider() !== "livekit" || !lk.isConfigured()) {
      return res.status(503).json({ error: "Audio classes are not set up yet" });
    }
    const room = String(req.body.room || "").trim().toLowerCase();
    if (!ROOM_RE.test(room)) return res.status(400).json({ error: "room is required" });
    if (!(await mayJoin(req.user, room))) return res.status(403).json({ error: "This is not your class" });
    if (!isStaff(req.user) && !(await lk.isRoomLive(room))) {
      return res.status(409).json({ error: "The class has not started yet", started: false });
    }
    const token = await lk.joinToken({ userId: req.user._id, name: req.user.name, room, staff: isStaff(req.user) });
    res.status(200).json({ token, url: process.env.LIVEKIT_URL, room });
  } catch (e) {
    fail(res, e, "Could not join the class");
  }
};

const roomArg = (req, res) => {
  const room = String(req.body.room || "").trim().toLowerCase();
  if (!ROOM_RE.test(room)) {
    res.status(400).json({ error: "room is required" });
    return null;
  }
  return room;
};

const setState = async (req, res) => {
  const room = roomArg(req, res);
  if (!room) return;
  try {
    const custom = req.body.custom && typeof req.body.custom === "object" ? req.body.custom : {};
    const text = JSON.stringify(custom);
    if (text.length > 60000) return res.status(400).json({ error: "State too large" });
    await lk.setRoomState(room, custom);
    res.status(200).json({ success: true });
  } catch (e) {
    fail(res, e, "Could not update the class");
  }
};

const kick = async (req, res) => {
  const room = roomArg(req, res);
  if (!room) return;
  try {
    await lk.removeUser(room, String(req.body.userId || ""));
    res.status(200).json({ success: true });
  } catch (e) {
    fail(res, e, "Could not remove the student");
  }
};

const mute = async (req, res) => {
  const room = roomArg(req, res);
  if (!room) return;
  try {
    if (req.body.all === true) {
      const n = await lk.muteAllExcept(room, req.user._id);
      return res.status(200).json({ success: true, muted: n });
    }
    const ids = (Array.isArray(req.body.userIds) ? req.body.userIds : []).map(String).slice(0, 500);
    await lk.muteUsers(room, ids);
    res.status(200).json({ success: true, muted: ids.length });
  } catch (e) {
    fail(res, e, "Could not mute");
  }
};

const end = async (req, res) => {
  const room = roomArg(req, res);
  if (!room) return;
  try {
    await lk.closeRoom(room); // everyone is disconnected → apps show "The trainer ended the class"
    if (req.io) req.io.to("admin_room").emit("live_rooms_changed", { room, live: false, at: Date.now() });
    if (String(room).startsWith("assembly_")) {
      // special class: tell every phone (also the minimized ones) to close it now
      if (req.io) req.io.emit("assembly_ended", { callId: room });
      require("./streamController").forgetAssembly();
    }
    res.status(200).json({ success: true });
  } catch (e) {
    fail(res, e, "Could not end the class");
  }
};

// =====================================================
// 👀 ADMIN / PRINCIPAL WATCHES ANY CLASS (no extra account)
//   GET  /api/rtc/live-rooms      → every class running now (today), with student count
//   POST /api/rtc/observe-token   { room } → join hidden + listen only
// =====================================================
const describeRoom = (name) => {
  let m = name.match(/^english_(stage\d)_sec([a-z0-9]+)_/);
  if (m) {
    return { language: "English", stage: m[1], section: m[2].toUpperCase(), mode: "online", kind: "class" };
  }
  m = name.match(/^hindi_(stage\d)_/);
  if (m) return { language: "Hindi", stage: m[1], section: "", mode: "online", kind: "class" };
  m = name.match(/^offline_(english|hindi)_(stage\d)_/);
  if (m) {
    return { language: m[1] === "hindi" ? "Hindi" : "English", stage: m[2], section: "", mode: "offline", kind: "class" };
  }
  if (name.startsWith("assembly_")) return { language: "", stage: "", section: "", mode: "online", kind: "special" };
  return { language: "", stage: "", section: "", mode: "", kind: "other" };
};

const liveRooms = async (req, res) => {
  try {
    if (lk.provider() !== "livekit" || !lk.isConfigured()) {
      return res.status(503).json({ error: "Audio classes are not set up yet" });
    }
    const tag = `_${todayTag()}_`;
    const list = (await lk.listLiveRooms())
      .filter((r) => r.name.includes(tag) || r.name.startsWith("assembly_"))
      .map((r) => ({ ...r, ...describeRoom(r.name) }))
      .filter((r) => r.kind !== "other")
      .sort((a, b) => (a.language + a.stage + a.section).localeCompare(b.language + b.stage + b.section));
    res.status(200).json({ rooms: list });
  } catch (e) {
    fail(res, e, "Could not load live classes");
  }
};

const observeToken = async (req, res) => {
  try {
    if (lk.provider() !== "livekit" || !lk.isConfigured()) {
      return res.status(503).json({ error: "Audio classes are not set up yet" });
    }
    const room = String(req.body.room || "").trim().toLowerCase();
    if (!ROOM_RE.test(room)) return res.status(400).json({ error: "room is required" });
    if (!(await lk.isRoomLive(room))) return res.status(409).json({ error: "This class has ended" });
    const speak = req.body.speak === true || req.body.speak === "true"; // 🎙 admin wants to talk
    if (speak) console.log(`🎙 Admin ${req.user.name} speaking in ${room}`);
    const token = await lk.joinToken({ userId: req.user._id, name: req.user.name, room, staff: true, observer: true, speak });
    res.status(200).json({ token, url: process.env.LIVEKIT_URL, room });
  } catch (e) {
    fail(res, e, "Could not open the class");
  }
};

// POST /api/rtc/observe-speak  { room, speak: true|false }
// The admin listening quietly presses "Speak" → visible as "Name (Admin)" + mic allowed.
const observeSpeak = async (req, res) => {
  try {
    if (lk.provider() !== "livekit" || !lk.isConfigured()) {
      return res.status(503).json({ error: "Audio classes are not set up yet" });
    }
    const room = String(req.body.room || "").trim().toLowerCase();
    if (!ROOM_RE.test(room)) return res.status(400).json({ error: "room is required" });
    const speak = req.body.speak === true || req.body.speak === "true";
    await lk.setObserverSpeaking(room, req.user._id, req.user.name, speak);
    res.status(200).json({ ok: true, speak });
  } catch (e) {
    if (/not.?found/i.test(String(e && e.message))) {
      return res.status(404).json({ error: "Join the class first" });
    }
    fail(res, e, "Could not change the mic");
  }
};

// GET /api/rtc/room-check?room=…  → everyone in the class + who is sending sound
const roomCheck = async (req, res) => {
  try {
    const room = String(req.query.room || "").trim().toLowerCase();
    if (!ROOM_RE.test(room)) return res.status(400).json({ error: "room is required" });
    const people = await lk.roomCheck(room);
    console.log(`🔍 Room check ${room}:`, JSON.stringify(people));
    res.status(200).json({ room, people });
  } catch (e) {
    fail(res, e, "Could not check the class");
  }
};

module.exports = {
  roomCheck,
  observeSpeak,
  rtcToken,
  roomToken,
  setState,
  kick,
  mute,
  end,
  liveRooms,
  observeToken,
  _internal: { mayJoin, describeRoom },
};
