const { StreamClient } = require("@stream-io/node-sdk");
const User = require("../../Models/users");
const { isValidId, STAFF_ROLES, ADMIN_ROLES, normStage, normLanguage } = require("../../utils/normalize");
const { getModes } = require("../../utils/classMode");
const { ensureUser, addMember } = require("../../utils/streamBatch");
const { dateKey } = require("../../utils/time");
const { effectiveSection } = require("./sectionMergeController");

// Keys come ONLY from environment variables. The old secret was public on
// GitHub — rotate it in the Stream dashboard and put the new one on Render.
let cachedClient = null;

// 🎙 Special class: is the admin's call live? (so 2,500 waiting students don't each ask Stream)
const assemblyLive = new Map(); // callId → { live, at }
const ASSEMBLY_CACHE_MS = 30000;
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

    // iat 5 min in the past: if this computer's clock is a little ahead of
    // Stream's servers, the token is still accepted ("token used before iat").
    const iat = Math.floor(Date.now() / 1000) - 5 * 60;
    const token = client.generateUserToken({
      user_id: id,
      iat,
      exp: iat + 6 * 60 * 60 + 5 * 60, // one class day, not 24h
    });

    // Must finish before the client joins, otherwise a trainer could join with the wrong role.
    // Cached per server process so 300 students joining at 5:30 AM don't make 300 Stream API calls.
    // Batched: 2,500 students opening the class at once = ~25 Stream calls, not 2,500
    await ensureUser(client, { id, name: user.name || "User", role: streamRole });

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
// CALL_VERSION: bump it (v3, v4 …) to give every class a brand-new, clean call
// if a call's data ever gets broken. "v3" leaves the calls broken by the old video setting behind.
const CALL_VERSION = process.env.STREAM_CALL_VERSION || "v3";
const today = () => dateKey().split("-").reverse().join(""); // YYYYMMDD (IST)

// 🌧 Rain day: an offline trainer's class held online (no sections offline)
const buildOfflineCallId = ({ language, stage }) =>
  `offline_${String(language).toLowerCase()}_${stage}_class_${today()}_${CALL_VERSION}`;

// 🎙 Principal class: ONE call for everyone (new id every time the admin starts it)
const buildAssemblyCallId = (assembly) =>
  `assembly_${(assembly && assembly.sessionKey) || "all"}_${today()}_${CALL_VERSION}`;

const buildCallId = ({ language, stage, section, type }) => {
  const day = today();
  if (language === "Hindi") return `hindi_${stage}_${type}_${day}_${CALL_VERSION}`;
  const sec = String(section || "a").toLowerCase().replace(/[^a-z0-9]/g, "") || "a";
  return `english_${stage}_sec${sec}_${type}_${day}_${CALL_VERSION}`;
};

// The apps (Stream Flutter 1.5) CRASH while joining if the call's custom data
// holds a null value ("type 'Null' is not a subtype of type 'Object'"), and
// show only "connect cancelled". Remove null values before anyone joins.
const hasNull = (obj) => !!obj && Object.values(obj).some((v) => v === null || v === undefined);
const withoutNulls = (obj) =>
  Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== null && v !== undefined));

const prepareCall = async (req, res) => {
  try {
    let user = req.user;
    if (!user) {
      const { userId } = req.body; // transition mode (no token yet)
      if (!isValidId(userId)) return res.status(400).json({ error: "userId is required" });
      user = await User.findById(userId).select("name role mode onlineSection teacherSection").lean();
      if (!user) return res.status(404).json({ error: "User not found" });
    }
    if (user.mode === undefined || user.onlineSection === undefined) {
      try {
        const u = await User.findById(user._id).select("mode onlineSection teacherSection").lean();
        user = { ...user, mode: u ? u.mode : user.mode || "online", onlineSection: u ? u.onlineSection : "", teacherSection: u ? u.teacherSection : "" };
      } catch (_) {
        user = { ...user, mode: user.mode || "online", onlineSection: user.onlineSection || "" };
      }
    }

    const language = normLanguage(req.body.language) || "English";
    const stage = normStage(req.body.stage) || "stage1";
    const rawType = String(req.body.type || "class").toLowerCase();
    const type = rawType === "club" ? "club" : "class";
    const modes = await getModes();
    const isAdmin = ADMIN_ROLES.includes(user.role);

    // 🎙 PRINCIPAL CLASS — admin hosts, everyone else listens
    if (rawType === "assembly") {
      if (!modes.assembly) {
        return res.status(200).json({ callId: "", started: false, assembly: false, message: "No principal class right now" });
      }
      const extra = { assembly: true, title: modes.assembly.title, startTime: modes.assembly.startTime };
      const assemblyId = buildAssemblyCallId(modes.assembly);
      if (isAdmin) {
        const ok = await hostCall(res, user, assemblyId, { ...extra, host: true });
        if (ok) {
          assemblyLive.set(assemblyId, { live: true, at: Date.now() });
          // everyone waiting on the "not started yet" screen joins right away
          if (req.io) req.io.emit("assembly_live", { callId: assemblyId, title: modes.assembly.title });
        }
        return;
      }
      return joinAsMember(res, user, assemblyId, extra);
    }

    // While the principal class is on, normal classes are paused
    if (modes.assembly && type === "class") {
      if (STAFF_ROLES.includes(user.role) && !isAdmin) {
        return res.status(409).json({
          error: `${modes.assembly.title || "Special class"} today at ${modes.assembly.startTime}. Normal classes are paused — join it from the special class card.`,
          assembly: true,
        });
      }
      return res.status(200).json({
        callId: buildCallId({ language, stage, section: req.body.section, type }),
        started: false,
        assemblyActive: true,
        message: `Today everyone joins ${modes.assembly.title || "the special class"} at ${modes.assembly.startTime}.`,
      });
    }

    // 🌧 RAIN DAY — offline trainer + offline students meet online (one class per stage)
    const rain = !!(modes.rain && type === "class" && user.mode === "offline");

    // 🔀 SECTION MERGE (English online classes): Section B merged into A →
    // B students join A's call. Decided HERE from the database, so a student
    // can never land in the wrong class (old app, cached section …).
    let section = req.body.section;
    let merge = {};
    if (!rain && language === "English" && type === "class") {
      const staff = STAFF_ROLES.includes(user.role);
      const own = staff ? section : (["A", "B", "C", "D", "E"].includes(String(user.onlineSection || "").toUpperCase()) ? user.onlineSection : section);
      const eff = await effectiveSection(stage, own);
      if (staff && eff.mergedInto && user.role === "teacher") {
        // Section B's trainer while B is merged into A
        return res.status(409).json({
          error: `Section ${String(own).toUpperCase()} is merged into Section ${eff.mergedInto} right now — your students are in Section ${eff.mergedInto}'s class. Tap "I'm back — unmerge" to teach your own class.`,
          merged: true,
          mergedInto: eff.mergedInto,
          mergeId: eff.mergeId,
        });
      }
      if (!staff) {
        section = eff.section;
        merge = { ownSection: String(own || "").toUpperCase(), section: eff.section, mergedInto: eff.mergedInto };
      }
    }

    const callId = rain
      ? buildOfflineCallId({ language, stage })
      : buildCallId({ language, stage, section, type });

    if (STAFF_ROLES.includes(user.role)) {
      const ok = await hostCall(res, user, callId, { rain });
      // students waiting to move into this class (merge / unmerge) join now
      if (ok && req.io && type === "class") {
        req.io.emit("class_started", { language, stage, section: String(section || "").toUpperCase(), callId, at: Date.now() });
      }
      return;
    }
    return joinAsMember(res, user, callId, { rain, ...merge });
  } catch (error) {
    console.error("Prepare call error:", error);
    res.status(502).json({ error: (error && error.message) || "Could not prepare the class" });
  }
};

// Trainer / admin starts (or returns to) a call
const hostCall = async (res, user, callId, extra = {}) => {
  try {
    const client = getStreamClient();
    const call = client.video.call("default", callId);
    const id = String(user._id);
    {
      // Make sure the trainer exists in Stream with the admin role
      await ensureUser(client, { id, name: user.name || "User", role: "admin" });
      // NOTE: do NOT change the call's video settings here. Stream Flutter 1.5
      // crashes ("Unexpected null value" in VideoSettingsResponse) when the
      // video settings are overridden. Audio-only is done in the apps instead
      // (they join with the camera OFF, so no camera permission is asked).
      const r = await call.getOrCreate({ data: { created_by_id: id } });
      if (r.call && r.call.backstage) await call.goLive().catch(() => {});
      // Trainer starts the class → fresh classroom state (mics open, no practice).
      // Also removes any broken (null) values left from earlier.
      if (r.call && r.call.custom && Object.keys(r.call.custom).length) {
        await call.update({ custom: {} }).catch((e) => console.error("Reset custom error:", e.message));
      }
      res.status(200).json({ callId, started: true, ...extra });
      return true;
    }
  } catch (error) {
    console.error("Host call error:", error);
    res.status(502).json({ error: (error && error.message) || "Could not prepare the class" });
    return false;
  }
};

// Students (and trainers in the principal class) may only join a call that is already live
const joinAsMember = async (res, user, callId, extra = {}) => {
  try {
    const client = getStreamClient();
    const call = client.video.call("default", callId);
    const id = String(user._id);
    const streamRole = STAFF_ROLES.includes(user.role) ? "admin" : "user";

    // 🎙 Special class: answer "not started yet" from memory (no Stream call per student)
    const cached = extra.assembly ? assemblyLive.get(callId) : null;
    const cacheFresh = cached && Date.now() - cached.at < ASSEMBLY_CACHE_MS;
    if (cacheFresh && !cached.live) return res.status(200).json({ callId, started: false, ...extra });

    let ended = false;
    if (!(cacheFresh && cached.live)) try {
      const r = await call.get();
      ended = !!(r.call && r.call.ended_at);
      if (!ended && r.call && hasNull(r.call.custom)) {
        await call.update({ custom: withoutNulls(r.call.custom) }).catch((e) => console.error("Clean custom error:", e.message));
      }
    } catch (e) {
      const status = e && e.metadata ? e.metadata.responseCode : null;
      if (status === 404 || (e && e.code === 16)) {
        if (extra.assembly) assemblyLive.set(callId, { live: false, at: Date.now() });
        return res.status(200).json({ callId, started: false, ...extra });
      }
      throw e;
    }
    if (extra.assembly && !(cacheFresh && cached.live)) assemblyLive.set(callId, { live: !ended, at: Date.now() });
    if (ended) return res.status(200).json({ callId, started: false, ...extra });

    // Add the student to the call as a member, so Stream lets them join
    // (a plain "user" may not be allowed to join/create calls on this app).
    // Batched (100 per Stream call) — strong enough for 2,500 joining together
    await ensureUser(client, { id, name: user.name || "User", role: streamRole });
    const memberError = await addMember(call, callId, id);
    return res.status(200).json({ callId, started: true, memberError, ...extra });
  } catch (error) {
    console.error("Join call error:", error);
    res.status(502).json({ error: (error && error.message) || "Could not prepare the class" });
  }
};

const forgetAssembly = () => assemblyLive.clear();

module.exports = {
  getStreamToken,
  prepareCall,
  forgetAssembly,
  _internal: { buildCallId, buildOfflineCallId, buildAssemblyCallId, assemblyLive },
};
