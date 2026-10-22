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
const { getModes } = require("../../utils/classMode");
const { dateKey } = require("../../utils/time");
const { STAFF_ROLES, normSection } = require("../../utils/normalize");
const { effectiveSection } = require("./sectionMergeController");

const isStaff = (u) => !!u && STAFF_ROLES.includes(u.role);
const todayTag = () => dateKey().split("-").reverse().join(""); // YYYYMMDD (IST)
const ROOM_RE = /^[a-z0-9_]{5,120}$/;

/** May this student join this room today? (staff: any room) */
const mayJoin = async (user, room) => {
  if (isStaff(user)) return true;
  if (!ROOM_RE.test(room) || !room.includes(`_${todayTag()}_`)) return false;

  if (room.startsWith("assembly_")) return !!(await getModes()).assembly;
  if (room.startsWith("offline_")) return user.mode === "offline";
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
    res.status(200).json({ success: true });
  } catch (e) {
    fail(res, e, "Could not end the class");
  }
};

module.exports = { rtcToken, roomToken, setState, kick, mute, end, _internal: { mayJoin } };
