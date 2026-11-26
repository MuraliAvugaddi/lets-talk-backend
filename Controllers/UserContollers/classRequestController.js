// =====================================================
// 🙋 STUDENT REQUESTS → TRAINER → MANAGER
//
// Example: Stage 2 • Section A • online • 5:30 AM batch student can't come
// today → "Can I join the 6:30 PM batch?"
//   1. Student writes to the trainer(s) of HIS CURRENT class
//      (promoted from Stage 2 → 3? only the Stage 3 trainer — never the old one)
//   2. Trainer gets a phone notification → Accept / Reply / Send to manager
//   3. Manager (online or offline manager) sees the request, the whole chat,
//      the student's phone + WhatsApp → solves it → "Solved"
//   4. Student (and trainer) get a notification at every step
// Works for online + offline, English + Hindi, every section.
// Trainers NEVER see the student's phone number — only managers do.
// =====================================================
const mongoose = require("mongoose");
const ClassRequest = require("../../Models/classRequest");
const User = require("../../Models/users");
const { STAGES, isLive } = require("../../utils/stageAccess");
const { stageBatch, normBatch } = require("../../utils/batches");
const push = require("../../utils/push");

const STAFF = ["manager", "admin"];
const MAX_WAITING = 3; // requests still waiting for an answer (open / with manager)
const MAX_PER_DAY = 15; // anti-spam: total sent in 24 h
const TYPE_LABEL = {
  other_batch: "Join another batch",
  absent: "Can't attend",
  other: "Other",
};

// India date helpers ("2026-11-26")
const istDay = (d = new Date()) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);
const prettyDay = (day) => {
  const d = new Date(`${day}T12:00:00+05:30`);
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
};
/** the class day the student picked: today … 30 days ahead (else today) */
const cleanForDate = (v) => {
  const s = String(v || "").trim();
  const today = istDay();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(new Date(`${s}T00:00:00+05:30`))) return today;
  const max = istDay(new Date(Date.now() + 30 * 86400000));
  return s < today ? today : s > max ? max : s;
};
const dayWord = (day) => {
  const today = istDay();
  if (day === today) return "today";
  if (day === istDay(new Date(Date.now() + 86400000))) return "tomorrow";
  return `on ${prettyDay(day)}`;
};

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const normLang = (v) => (String(v || "").trim().toLowerCase() === "hindi" ? "Hindi" : String(v || "").trim().toLowerCase() === "english" ? "English" : null);
const normStage = (v) => {
  const n = String(v || "").toLowerCase().replace(/[^0-9]/g, "");
  return STAGES.includes(`stage${n}`) ? `stage${n}` : null;
};
const secKey = (v) =>
  String(v || "")
    .toLowerCase()
    .replace(/section|sec|\s|-/g, "")
    .trim();
const stageNo = (st) => String(st || "").replace("stage", "");
const modeOf = (u) => (String(u.mode || "online").toLowerCase() === "offline" ? "offline" : "online");
const classLabel = (r) =>
  `${r.language} • Stage ${stageNo(r.stage)}${r.section && secKey(r.section) !== "none" ? ` • Section ${String(r.section).replace(/section/i, "").trim().toUpperCase()}` : ""} • ${r.mode === "offline" ? "Offline" : "Online"}`;

// ---------------------------------------------------------------
// who teaches this class?
// ---------------------------------------------------------------
const trainersFor = async ({ mode, language, stage, section }) => {
  const find = (st) =>
    User.find({
      role: "teacher",
      mode,
      language,
      teacherStage: { $regex: `^stage\\s*${stageNo(st)}$`, $options: "i" },
    })
      .select("_id name teacherSection")
      .lean();

  let list = await find(stage);
  // online English → only the trainer of the student's section
  if (mode === "online" && language === "English" && secKey(section) && secKey(section) !== "none") {
    const own = list.filter((t) => secKey(t.teacherSection) === secKey(section));
    if (own.length) list = own;
  }
  // Hindi stage merged into another stage → that class's trainer
  if (!list.length && language === "Hindi") {
    try {
      const { hostOfStage } = require("./hindiStageMergeController");
      const m = await hostOfStage(stage);
      if (m && m.hostStage) list = await find(m.hostStage);
    } catch (_) {}
  }
  return list;
};

/** online manager for online students, offline manager for offline students (else every manager/admin) */
const managersFor = async (mode) => {
  let list = await User.find({ role: "manager", mode }).select("_id name").lean();
  if (!list.length) list = await User.find({ role: { $in: STAFF } }).select("_id name").lean();
  return list;
};

// ---------------------------------------------------------------
// live update + phone notification
// ---------------------------------------------------------------
const emit = (req, ids, payload) => {
  if (!req.io) return;
  for (const id of ids) req.io.to(String(id)).emit("request_update", payload);
  req.io.to("admin_room").emit("request_update", payload);
};
const notify = (ids, title, body, id) => {
  const list = [...new Set(ids.map(String))].filter(Boolean);
  if (!list.length) return;
  push.later(() =>
    push.toUsers(list, {
      title,
      body: body.length > 170 ? `${body.slice(0, 167)}…` : body,
      data: { type: "class_request", click: "requests", id: String(id) },
    })
  );
};

const view = (r, role) => {
  const out = {
    id: String(r._id),
    studentName: r.studentName,
    language: r.language,
    stage: r.stage,
    section: r.section,
    mode: r.mode,
    classLabel: classLabel(r),
    batchTime: r.batchTime,
    type: r.type,
    typeLabel: TYPE_LABEL[r.type] || "Other",
    preferredBatch: r.preferredBatch,
    forDate: r.forDate || (r.createdAt ? istDay(new Date(r.createdAt)) : ""),
    status: r.status,
    trainerNames: r.trainerNames || [],
    acceptedByName: r.acceptedByName || "",
    escalatedByName: r.escalatedByName || "",
    solvedByName: r.solvedByName || "",
    messages: (r.messages || []).map((m) => ({ byName: m.byName, role: m.role, text: m.text, at: m.at })),
    createdAt: r.createdAt,
    lastActivityAt: r.lastActivityAt,
  };
  // 📞 only managers see how to reach the student
  if (STAFF.includes(role) && r.student && typeof r.student === "object" && r.student.phone) {
    out.studentPhone = r.student.phone;
  }
  return out;
};

const canSee = (user, r) => {
  if (!user) return false;
  if (STAFF.includes(user.role)) return true;
  const sid = String(r.student && r.student._id ? r.student._id : r.student);
  if (user.role === "student") return sid === String(user._id);
  if (user.role === "teacher") return (r.trainers || []).some((t) => String(t) === String(user._id));
  return false;
};

const load = async (id) => (isId(id) ? ClassRequest.findById(id).populate("student", "name phone") : null);

// ---------------------------------------------------------------
// STUDENT: which classes can I message?  GET /api/requests/my-classes
// (only CURRENT stages — a finished / promoted stage is not here)
// ---------------------------------------------------------------
const myClasses = async (req, res) => {
  try {
    const u = req.user;
    if (!u || u.role !== "student") return res.status(403).json({ message: "Students only" });
    const mode = modeOf(u);
    const out = [];
    for (const language of ["English", "Hindi"]) {
      for (const stage of STAGES) {
        if (!isLive(u, language, stage)) continue;
        const section = mode === "online" && language === "English" ? u.onlineSection || "" : "";
        const trainers = await trainersFor({ mode, language, stage, section });
        const r = { language, stage, section, mode };
        out.push({
          language,
          stage,
          section,
          mode,
          classLabel: classLabel(r),
          batchTime: stageBatch(u, language, stage),
          trainerNames: trainers.map((t) => t.name),
        });
      }
    }
    res.status(200).json({ classes: out });
  } catch (e) {
    console.error("my-classes error:", e);
    res.status(500).json({ message: "Server Error" });
  }
};

// ---------------------------------------------------------------
// STUDENT: new request  POST /api/requests
// { language, stage, type, preferredBatch, message }
// ---------------------------------------------------------------
const createRequest = async (req, res) => {
  try {
    const u = req.user;
    if (!u || u.role !== "student") return res.status(403).json({ message: "Students only" });
    const language = normLang(req.body.language);
    const stage = normStage(req.body.stage);
    const type = TYPE_LABEL[req.body.type] ? req.body.type : "other";
    const preferredBatch = type === "other_batch" ? normBatch(req.body.preferredBatch) || "" : "";
    const text = String(req.body.message || "").trim().slice(0, 1000);
    const forDate = cleanForDate(req.body.forDate);

    if (!language || !stage) return res.status(400).json({ message: "Choose your class." });
    if (!isLive(u, language, stage)) {
      return res.status(403).json({
        message: "You can message only the trainer of your CURRENT class (after promotion, your new stage).",
      });
    }
    if (type === "other_batch" && !preferredBatch) return res.status(400).json({ message: "Choose the batch you want to join." });
    if (!text && type === "other") return res.status(400).json({ message: "Write your message." });

    // answered requests (accepted / solved) never block a new one
    const waiting = await ClassRequest.countDocuments({ student: u._id, status: { $in: ["open", "escalated"] } });
    if (waiting >= MAX_WAITING) {
      return res.status(429).json({
        message: `You already have ${waiting} requests waiting for a reply. Please wait until your trainer answers them.`,
      });
    }
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const today = await ClassRequest.countDocuments({ student: u._id, createdAt: { $gte: since } });
    if (today >= MAX_PER_DAY) {
      return res.status(429).json({ message: "Too many requests today. Please try again tomorrow." });
    }

    const mode = modeOf(u);
    const section = mode === "online" && language === "English" ? u.onlineSection || "" : "";
    const trainers = await trainersFor({ mode, language, stage, section });
    const batchTime = stageBatch(u, language, stage);

    const first =
      type === "other_batch"
        ? `🔁 I can't attend my ${batchTime || "usual"} batch ${dayWord(forDate)}. Can I join the ${preferredBatch} batch?${text ? `\n${text}` : ""}`
        : type === "absent"
        ? `🙏 I can't attend the class ${dayWord(forDate)}.${text ? `\n${text}` : ""}`
        : text;

    const messages = [{ by: u._id, byName: u.name || "Student", role: "student", text: first, at: new Date() }];
    let status = "open";
    let managers = [];
    if (!trainers.length) {
      status = "escalated";
      messages.push({ role: "system", byName: "Let's Speak", text: "No trainer is set for this class yet — sent to the manager.", at: new Date() });
      managers = await managersFor(mode);
    }

    const doc = await ClassRequest.create({
      student: u._id,
      studentName: u.name || "Student",
      language,
      stage,
      section,
      mode,
      batchTime,
      type,
      preferredBatch,
      forDate,
      status,
      trainers: trainers.map((t) => t._id),
      trainerNames: trainers.map((t) => t.name),
      messages,
      escalatedAt: status === "escalated" ? new Date() : null,
      lastActivityAt: new Date(),
    });

    const label = classLabel(doc);
    const short = `${type === "other_batch" ? `wants to join the ${preferredBatch} batch` : TYPE_LABEL[type]} ${dayWord(forDate)}`;
    if (trainers.length) {
      notify(trainers.map((t) => t._id), `🙋 Request from ${doc.studentName}`, `${label} • ${short}${text ? ` — ${text}` : ""}`, doc._id);
    } else {
      notify(managers.map((m) => m._id), `🙋 Request (no trainer) • ${doc.studentName}`, `${label} • ${short}`, doc._id);
    }
    emit(req, [...trainers.map((t) => t._id), ...managers.map((m) => m._id), u._id], { id: String(doc._id), status });

    console.log(`🙋 Request ${doc.studentName} → ${label} (${trainers.length} trainer${trainers.length === 1 ? "" : "s"})`);
    res.status(201).json({
      success: true,
      message: trainers.length ? `Sent to ${trainers.map((t) => t.name).join(", ")}` : "Sent to the manager",
      request: view(doc, "student"),
    });
  } catch (e) {
    console.error("create request error:", e);
    res.status(500).json({ message: "Server Error" });
  }
};

// ---------------------------------------------------------------
// LISTS
// ---------------------------------------------------------------
const myRequests = async (req, res) => {
  try {
    const rows = await ClassRequest.find({ student: req.user._id }).sort({ lastActivityAt: -1 }).limit(50).lean();
    res.status(200).json({ requests: rows.map((r) => view(r, "student")) });
  } catch (e) {
    res.status(500).json({ message: "Server Error" });
  }
};

const trainerRequests = async (req, res) => {
  try {
    const q = { trainers: req.user._id };
    if (req.query.status && req.query.status !== "all") q.status = req.query.status;
    const rows = await ClassRequest.find(q).sort({ lastActivityAt: -1 }).limit(100).lean();
    const open = await ClassRequest.countDocuments({ trainers: req.user._id, status: "open" });
    res.status(200).json({ open, requests: rows.map((r) => view(r, "teacher")) });
  } catch (e) {
    res.status(500).json({ message: "Server Error" });
  }
};

// 📅 extra filters for the manager list: ?stage=2&section=A&batch=05:30 AM - 07:00 AM&from=2026-11-01&to=2026-11-26
// dates are India days (IST); batch matches the student's own batch OR the batch they want to join
const IST_DAY = /^\d{4}-\d{2}-\d{2}$/;
const escRe = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const extraFilters = (qs = {}) => {
  const q = {};
  const st = normStage(qs.stage);
  if (st) q.stage = st;
  const sec = secKey(qs.section);
  if (sec && sec !== "all") q.section = { $regex: `^\\s*(section\\s*)?${escRe(sec)}\\s*$`, $options: "i" };
  const and = [];
  const b = normBatch(qs.batch);
  if (b) and.push({ $or: [{ batchTime: b }, { preferredBatch: b }] });
  const from = IST_DAY.test(String(qs.from || "")) ? String(qs.from) : "";
  const to = IST_DAY.test(String(qs.to || "")) ? String(qs.to) : "";
  if (from || to) {
    const day = {};
    const created = {};
    if (from) {
      day.$gte = from;
      created.$gte = new Date(`${from}T00:00:00.000+05:30`);
    }
    if (to) {
      day.$lte = to;
      created.$lte = new Date(`${to}T23:59:59.999+05:30`);
    }
    // class day = forDate; old requests without it → the day they were sent
    and.push({ $or: [{ forDate: day }, { forDate: { $in: [null, ""] }, createdAt: created }] });
  }
  if (and.length) q.$and = and;
  return q;
};

const managerRequests = async (req, res) => {
  try {
    const q = {};
    if (req.query.status && req.query.status !== "all") q.status = req.query.status;
    if (["online", "offline"].includes(req.query.mode)) q.mode = req.query.mode;
    if (normLang(req.query.language)) q.language = normLang(req.query.language);
    Object.assign(q, extraFilters(req.query));
    const rows = await ClassRequest.find(q).sort({ lastActivityAt: -1 }).limit(200).populate("student", "name phone").lean();
    const counts = {};
    for (const s of ["open", "accepted", "escalated", "solved"]) counts[s] = await ClassRequest.countDocuments({ ...q, status: s });
    res.status(200).json({ counts, requests: rows.map((r) => view(r, req.user.role)) });
  } catch (e) {
    res.status(500).json({ message: "Server Error" });
  }
};

const getRequest = async (req, res) => {
  try {
    const r = await load(req.params.id);
    if (!r || !canSee(req.user, r)) return res.status(404).json({ message: "Request not found" });
    res.status(200).json({ request: view(r, req.user.role) });
  } catch (e) {
    res.status(500).json({ message: "Server Error" });
  }
};

// ---------------------------------------------------------------
// ACTIONS
// ---------------------------------------------------------------
const addMsg = (r, user, text) =>
  r.messages.push({ by: user._id, byName: user.name || "", role: user.role, text: String(text).trim().slice(0, 1000), at: new Date() });

const others = async (r, user) => {
  const sid = String(r.student && r.student._id ? r.student._id : r.student);
  const ids = [];
  if (user.role !== "student") ids.push(sid);
  if (user.role !== "teacher" || STAFF.includes(user.role)) ids.push(...(r.trainers || []).map(String));
  if (r.status === "escalated" && !STAFF.includes(user.role)) ids.push(...(await managersFor(r.mode)).map((m) => String(m._id)));
  return [...new Set(ids)].filter((id) => id !== String(user._id));
};

// POST /api/requests/:id/reply { text }
const reply = async (req, res) => {
  try {
    const r = await load(req.params.id);
    if (!r || !canSee(req.user, r)) return res.status(404).json({ message: "Request not found" });
    const text = String(req.body.text || "").trim();
    if (!text) return res.status(400).json({ message: "Write a message." });
    if (r.status === "solved") return res.status(400).json({ message: "This request is closed. Send a new request." });
    addMsg(r, req.user, text);
    r.lastActivityAt = new Date();
    await r.save();
    const to = await others(r, req.user);
    notify(to, `💬 ${req.user.name || "New reply"}`, `${r.studentName} • ${classLabel(r)}: ${text}`, r._id);
    emit(req, [...to, req.user._id], { id: String(r._id), status: r.status });
    res.status(200).json({ success: true, request: view(r, req.user.role) });
  } catch (e) {
    console.error("reply error:", e);
    res.status(500).json({ message: "Server Error" });
  }
};

// POST /api/requests/:id/accept { text? }  (trainer)
const accept = async (req, res) => {
  try {
    const r = await load(req.params.id);
    if (!r || !canSee(req.user, r) || req.user.role !== "teacher") return res.status(404).json({ message: "Request not found" });
    if (r.status === "solved") return res.status(400).json({ message: "Already solved." });
    r.status = "accepted";
    r.acceptedByName = req.user.name || "Trainer";
    addMsg(r, req.user, String(req.body.text || "").trim() || "✅ OK, accepted.");
    r.lastActivityAt = new Date();
    await r.save();
    const sid = String(r.student._id || r.student);
    notify([sid], `✅ ${r.acceptedByName} accepted your request`, `${classLabel(r)}${r.preferredBatch ? ` • join the ${r.preferredBatch} batch` : ""}`, r._id);
    emit(req, [sid, ...(r.trainers || [])], { id: String(r._id), status: r.status });
    res.status(200).json({ success: true, request: view(r, "teacher") });
  } catch (e) {
    res.status(500).json({ message: "Server Error" });
  }
};

// POST /api/requests/:id/escalate { text? }  (trainer → manager)
const escalate = async (req, res) => {
  try {
    const r = await load(req.params.id);
    if (!r || !canSee(req.user, r) || req.user.role !== "teacher") return res.status(404).json({ message: "Request not found" });
    if (r.status === "solved") return res.status(400).json({ message: "Already solved." });
    r.status = "escalated";
    r.escalatedByName = req.user.name || "Trainer";
    r.escalatedAt = new Date();
    addMsg(r, req.user, String(req.body.text || "").trim() || "📨 Sent to the manager.");
    r.lastActivityAt = new Date();
    await r.save();
    const managers = await managersFor(r.mode);
    const sid = String(r.student._id || r.student);
    notify(managers.map((m) => m._id), `📨 Request needs manager • ${r.studentName}`, `${classLabel(r)} • from ${r.escalatedByName}`, r._id);
    notify([sid], "📨 Your request was sent to the manager", `${r.escalatedByName} sent it to the manager. They will help you soon.`, r._id);
    emit(req, [sid, ...managers.map((m) => m._id), ...(r.trainers || [])], { id: String(r._id), status: r.status });
    res.status(200).json({ success: true, request: view(r, "teacher") });
  } catch (e) {
    res.status(500).json({ message: "Server Error" });
  }
};

// POST /api/requests/:id/solve { text? }  (manager / admin)
const solve = async (req, res) => {
  try {
    const r = await load(req.params.id);
    if (!r) return res.status(404).json({ message: "Request not found" });
    r.status = "solved";
    r.solvedByName = req.user.name || "Manager";
    r.solvedAt = new Date();
    addMsg(r, req.user, String(req.body.text || "").trim() || "✅ Solved by the manager.");
    r.lastActivityAt = new Date();
    await r.save();
    const sid = String(r.student._id || r.student);
    notify([sid], "✅ Your request is solved", `${r.solvedByName}: ${r.messages[r.messages.length - 1].text}`, r._id);
    notify((r.trainers || []).map(String), `✅ Manager solved ${r.studentName}'s request`, classLabel(r), r._id);
    emit(req, [sid, ...(r.trainers || [])], { id: String(r._id), status: r.status });
    res.status(200).json({ success: true, request: view(r, req.user.role) });
  } catch (e) {
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = {
  myClasses,
  createRequest,
  myRequests,
  trainerRequests,
  extraFilters,
  managerRequests,
  getRequest,
  reply,
  accept,
  escalate,
  solve,
  _internal: { trainersFor, secKey, classLabel, view, cleanForDate, istDay },
};