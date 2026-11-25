// =====================================================
// 📨 STAGE MESSAGES — admin writes to a group of students
//    language (English / Hindi / both) + stages (1–7 or all) + online / offline / both
//    • only matching students see it in the app ("Messages" page)
//    • they also get a phone notification
//    • live: open apps update at once (socket "stage_message")
// =====================================================
const StageMessage = require("../../Models/stageMessage");
const User = require("../../Models/users");
const { STAGES, fields, plain } = require("../../utils/stageAccess");
const push = require("../../utils/push");
const bus = require("../../utils/clusterBus");

const KEEP_DAYS = 60; // students see messages of the last 60 days
const MAX_LIST = 200;

// ---------- small cache (2,000 students open the app at class time) ----------
let cache = null; // { at, rows }
const CACHE_MS = 20 * 1000;
bus.on("stageMessages.clear", () => {
  cache = null;
});
const clearCache = () => {
  cache = null;
  bus.publish("stageMessages.clear");
};

const recent = async () => {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const since = new Date(Date.now() - KEEP_DAYS * 24 * 3600 * 1000);
  const rows = await StageMessage.find({ createdAt: { $gte: since } })
    .sort({ createdAt: -1 })
    .limit(MAX_LIST)
    .lean();
  cache = { at: Date.now(), rows };
  return rows;
};

// ---------- input cleaning ----------
const cleanLang = (v) => {
  const s = String(v || "").trim().toLowerCase();
  if (s === "hindi") return "Hindi";
  if (s === "english") return "English";
  if (s === "all" || s === "both") return "All";
  return null;
};
const cleanMode = (v) => {
  const s = String(v || "all").trim().toLowerCase();
  return ["all", "online", "offline"].includes(s) ? s : null;
};
const cleanStages = (v) => {
  const list = Array.isArray(v) ? v : String(v || "").split(",");
  const out = [];
  for (const x of list) {
    const n = String(x).toLowerCase().replace(/[^0-9]/g, "");
    const st = `stage${n}`;
    if (STAGES.includes(st) && !out.includes(st)) out.push(st);
  }
  return out.sort();
};

const langsOf = (language) => (language === "All" ? ["English", "Hindi"] : [language]);
const stagesOf = (stages) => (stages && stages.length ? stages : STAGES);
const userMode = (u) => (String(u.mode || "online").toLowerCase() === "offline" ? "offline" : "online");

/** Is this message for this student? (current stage(s) only — not finished stages) */
const isFor = (user, msg) => {
  if (!user || user.role !== "student") return false;
  if (msg.mode !== "all" && msg.mode !== userMode(user)) return false;
  return langsOf(msg.language).some((L) => {
    const access = plain(user[fields(L).access]);
    return stagesOf(msg.stages).some((s) => access[s]);
  });
};

/** MongoDB filter for the same students (for the phone notification) */
const studentFilter = (msg) => {
  const or = [];
  for (const L of langsOf(msg.language)) {
    for (const s of stagesOf(msg.stages)) or.push({ [`${fields(L).access}.${s}`]: true });
  }
  const q = { role: "student", isDropout: { $ne: true }, $or: or };
  if (msg.mode === "offline") q.mode = "offline";
  if (msg.mode === "online") q.mode = { $ne: "offline" };
  return q;
};

/** "English • Stage 1, 2 • Online" */
const groupLabel = (msg) => {
  const lang = msg.language === "All" ? "English & Hindi" : msg.language;
  const st = msg.stages && msg.stages.length ? `Stage ${msg.stages.map((s) => s.replace("stage", "")).join(", ")}` : "All stages";
  const mode = msg.mode === "all" ? "Online & Offline" : msg.mode === "online" ? "Online" : "Offline";
  return `${lang} • ${st} • ${mode}`;
};

const view = (m) => ({
  id: String(m._id),
  title: m.title || "",
  message: m.message,
  language: m.language,
  stages: m.stages || [],
  mode: m.mode,
  group: groupLabel(m),
  sentTo: m.sentTo || 0,
  sentByName: m.sentByName || "",
  createdAt: m.createdAt,
});

// ---------------------------------------------------------------
// GET /api/stage-messages        → student: only MY messages
//                                 → admin / manager: everything (for the admin list)
// ---------------------------------------------------------------
const listMessages = async (req, res) => {
  try {
    const rows = await recent();
    const u = req.user;
    const staff = u && ["admin", "manager"].includes(u.role);
    const mine = staff ? rows : rows.filter((m) => isFor(u, m));
    res.set("Cache-Control", "no-store");
    res.status(200).json({ success: true, messages: mine.map(view) });
  } catch (error) {
    console.error("List stage messages error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// ---------------------------------------------------------------
// POST /api/stage-messages  (admin)  { title, message, language, stages[], mode }
// ---------------------------------------------------------------
const sendMessage = async (req, res) => {
  try {
    const message = String(req.body.message || "").trim();
    const title = String(req.body.title || "").trim().slice(0, 120);
    const language = cleanLang(req.body.language);
    const mode = cleanMode(req.body.mode);
    const stages = cleanStages(req.body.stages);

    if (!message) return res.status(400).json({ message: "Write a message." });
    if (message.length > 2000) return res.status(400).json({ message: "Message too long (max 2000 letters)." });
    if (!language) return res.status(400).json({ message: "Choose English, Hindi or both." });
    if (!mode) return res.status(400).json({ message: "Choose online, offline or both." });

    const draft = { title, message, language, stages, mode };
    const ids = (await User.find(studentFilter(draft)).select("_id").lean()).map((u) => u._id);

    const doc = await StageMessage.create({
      ...draft,
      sentTo: ids.length,
      sentBy: req.user ? req.user._id : null,
      sentByName: req.user ? req.user.name || "" : "",
    });
    clearCache();

    // ⚡ open apps refresh their list (each phone checks if it is for them)
    if (req.io) req.io.emit("stage_message", { action: "new", id: String(doc._id), language, stages, mode });

    // 🔔 phone notification only to these students
    if (ids.length) {
      const body = message.length > 180 ? `${message.slice(0, 177)}…` : message;
      push.later(() =>
        push.toUsers(ids, {
          title: title ? `📨 ${title}` : `📨 Message • ${groupLabel(doc)}`,
          body,
          data: { click: "messages", type: "stage_message", id: String(doc._id) },
        })
      );
    }

    console.log(`📨 Stage message → ${groupLabel(doc)} (${ids.length} students)`);
    res.status(201).json({
      success: true,
      message: `Sent to ${ids.length} student${ids.length === 1 ? "" : "s"}`,
      data: view(doc),
    });
  } catch (error) {
    console.error("Send stage message error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// ---------------------------------------------------------------
// DELETE /api/stage-messages/:id  (admin)
// ---------------------------------------------------------------
const deleteMessage = async (req, res) => {
  try {
    const doc = await StageMessage.findByIdAndDelete(req.params.id).lean();
    if (!doc) return res.status(404).json({ message: "Message not found" });
    clearCache();
    if (req.io) req.io.emit("stage_message", { action: "deleted", id: String(doc._id) });
    res.status(200).json({ success: true, message: "Message deleted" });
  } catch (error) {
    console.error("Delete stage message error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { listMessages, sendMessage, deleteMessage, isFor, studentFilter, groupLabel, cleanStages };
