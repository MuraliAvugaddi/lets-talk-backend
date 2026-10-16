const { StreamClient } = require("@stream-io/node-sdk");
const User = require("../../Models/users");
const { isValidId, STAFF_ROLES, normStage, normLanguage } = require("../../utils/normalize");
const { dateKey } = require("../../utils/time");

// Keys come ONLY from environment variables. The old secret was public on
// GitHub — rotate it in the Stream dashboard and put the new one on Render.
let cachedClient = null;
const upsertedUsers = new Map(); // userId → "role|name" already pushed to Stream
const getStreamClient = () => {
  if (!cachedClient) {
    const { STREAM_API_KEY, STREAM_API_SECRET } = process.env;
    if (!STREAM_API_KEY || !STREAM_API_SECRET) {
      throw new Error("STREAM_API_KEY / STREAM_API_SECRET are not set");
    }
    cachedClient = new StreamClient(STREAM_API_KEY, STREAM_API_SECRET);
  }
  return cachedClient;
};

// POST /api/stream/token
// The Stream role is decided by the DATABASE role, never by the request body.
const getStreamToken = async (req, res) => {
  try {
    let user = req.user;
    if (!user) {
      const { userId } = req.body; // transition mode (no token yet)
      if (!isValidId(userId)) return res.status(400).json({ error: "userId is required" });
      user = await User.findById(userId).select("name role").lean();
      if (!user) return res.status(404).json({ error: "User not found" });
    }

    const id = String(user._id);
    const streamRole = STAFF_ROLES.includes(user.role) ? "admin" : "user";
    const client = getStreamClient();

    const token = client.generateUserToken({
      user_id: id,
      validity_in_seconds: 6 * 60 * 60, // one class day, not 24h
    });

    // Must finish before the client joins, otherwise a trainer could join with the wrong role.
    // Cached per server process so 300 students joining at 5:30 AM don't make 300 Stream API calls.
    const signature = `${streamRole}|${user.name || "User"}`;
    if (upsertedUsers.get(id) !== signature) {
      await client.upsertUsers([{ id, name: user.name || "User", role: streamRole }]);
      upsertedUsers.set(id, signature);
    }

    res.status(200).json({ token, userId: id, role: streamRole, apiKey: process.env.STREAM_API_KEY });
  } catch (error) {
    console.error("Error generating Stream token:", error);
    res.status(500).json({ error: "Could not create class token" });
  }
};

// =====================================================
// POST /api/stream/prepare-call  { language, stage, section, type }
// The SERVER decides the call id and creates the call, so:
//   • a new, clean call every day (yesterday's ended/locked state never sticks)
//   • trainers never need "create call" permission on the phone
//   • students learn "class not started yet" instead of a cryptic error
//   • any Stream problem comes back as a readable message
// =====================================================
const buildCallId = ({ language, stage, section, type }) => {
  const day = dateKey().split("-").reverse().join(""); // YYYYMMDD (IST)
  if (language === "Hindi") return `hindi_${stage}_${type}_${day}`;
  const sec = String(section || "a").toLowerCase().replace(/[^a-z0-9]/g, "") || "a";
  return `english_${stage}_sec${sec}_${type}_${day}`;
};

const prepareCall = async (req, res) => {
  try {
    let user = req.user;
    if (!user) {
      const { userId } = req.body; // transition mode (no token yet)
      if (!isValidId(userId)) return res.status(400).json({ error: "userId is required" });
      user = await User.findById(userId).select("name role").lean();
      if (!user) return res.status(404).json({ error: "User not found" });
    }

    const language = normLanguage(req.body.language) || "English";
    const stage = normStage(req.body.stage) || "stage1";
    const type = String(req.body.type || "class").toLowerCase() === "club" ? "club" : "class";
    const callId = buildCallId({ language, stage, section: req.body.section, type });

    const client = getStreamClient();
    const call = client.video.call("default", callId);
    const id = String(user._id);
    const isStaff = STAFF_ROLES.includes(user.role);

    if (isStaff) {
      // Make sure the trainer exists in Stream with the admin role
      const signature = `admin|${user.name || "User"}`;
      if (upsertedUsers.get(id) !== signature) {
        await client.upsertUsers([{ id, name: user.name || "User", role: "admin" }]);
        upsertedUsers.set(id, signature);
      }
      const r = await call.getOrCreate({ data: { created_by_id: id } });
      if (r.call && r.call.backstage) await call.goLive().catch(() => {});
      return res.status(200).json({ callId, started: true });
    }

    // Students may only join a class the trainer has already started today
    let ended = false;
    try {
      const r = await call.get();
      ended = !!(r.call && r.call.ended_at);
    } catch (e) {
      const status = e && e.metadata ? e.metadata.responseCode : null;
      if (status === 404 || (e && e.code === 16)) return res.status(200).json({ callId, started: false });
      throw e;
    }
    if (ended) return res.status(200).json({ callId, started: false });

    // Add the student to the call as a member, so Stream lets them join
    // (a plain "user" may not be allowed to join/create calls on this app).
    const signature = `user|${user.name || "User"}`;
    if (upsertedUsers.get(id) !== signature) {
      await client.upsertUsers([{ id, name: user.name || "User", role: "user" }]);
      upsertedUsers.set(id, signature);
    }
    let memberError = null;
    try {
      await call.updateCallMembers({ update_members: [{ user_id: id, role: "call_member" }] });
    } catch (e) {
      memberError = (e && e.message) || String(e);
      console.error("Add call member error:", memberError);
    }
    return res.status(200).json({ callId, started: true, memberError });
  } catch (error) {
    console.error("Prepare call error:", error);
    res.status(502).json({ error: (error && error.message) || "Could not prepare the class" });
  }
};

module.exports = { getStreamToken, prepareCall, _internal: { buildCallId } };
