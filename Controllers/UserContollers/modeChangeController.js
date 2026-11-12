// =====================================================
// 🔁 ONLINE ↔ OFFLINE CHANGE (admin)
//
//   POST /api/admin/change-mode      { userId, mode, duration, reason }
//        duration: "1d" | "2d" | "1w" | "permanent"
//        1d = today only (after 7 PM → tomorrow too), 2d = today + tomorrow,
//        1w = 7 days. Then the student goes back by itself.
//   POST /api/admin/change-mode/end  { userId }   go back to the normal mode now
//   GET  /api/admin/mode-changes?status=active|all&mode=online|offline&language=&stage=&q=
//        → "Converted students" list in the admin app
//
// The trainer roster already lists students by their CURRENT mode, so a student
// who is "online for 1 day" shows in the online trainer's list with a badge
// (fields modeBase + modeTempUntil come with every student).
// =====================================================
const User = require("../../Models/users");
const ModeChange = require("../../Models/modeChange");
const notify = require("../../utils/notify");
const { dateKey, istDayRange, istMinutesOfDay } = require("../../utils/time");
const { normMode, normLanguage, normStage, isValidId, escapeRegex, isAll } = require("../../utils/normalize");

const DAYS = { "1d": 1, "2d": 2, "1w": 7 };
const LATE_EVENING_MIN = 19 * 60; // after 7 PM "1 day" means tomorrow's class

/** End of the last IST day of a temporary change */
const untilFor = (duration, now = new Date()) => {
  let days = DAYS[duration];
  if (!days) return null;
  if (istMinutesOfDay(now) >= LATE_EVENING_MIN) days += 1; // set at night → for tomorrow
  const last = new Date(now.getTime() + (days - 1) * 24 * 60 * 60 * 1000);
  return istDayRange(dateKey(last)).end;
};

const fmtDay = (d) =>
  new Date(d).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });

const publicMode = (u) => ({
  mode: u.mode,
  modeBase: u.modeBase || "",
  modeTempUntil: u.modeTempUntil || null,
});

/** Tell the student's phone + admin screens; push notification */
const broadcast = (io, user, message) => {
  if (io) {
    io.to(String(user._id)).emit("permissions_updated", {
      feeStatus: user.feeStatus,
      onlineSection: user.onlineSection,
      mode: user.mode,
      modeBase: user.modeBase || "",
      modeTempUntil: user.modeTempUntil || null,
      batchTime: user.batchTime,
      englishBatch: user.englishBatch,
      hindiBatch: user.hindiBatch,
    });
    io.to("admin_room").emit("student_update", {
      userId: String(user._id),
      by: "admin",
      user: { _id: user._id, id: user._id, name: user.name, phone: user.phone, ...publicMode(user) },
    });
    // 🔁 "Converted students" screen refreshes by itself
    io.to("admin_room").emit("mode_change_update", { userId: String(user._id), mode: user.mode, at: Date.now() });
  }
  notify.modeChanged(user, message);
};

const closeActive = (userId, status) =>
  ModeChange.updateMany({ userId, status: "active" }, { $set: { status, endedAt: new Date() } });

// POST /admin/change-mode
const changeMode = async (req, res) => {
  try {
    const { userId, duration, reason } = req.body;
    const mode = normMode(req.body.mode);
    if (!isValidId(userId)) return res.status(400).json({ message: "Valid userId required" });
    if (!mode) return res.status(400).json({ message: "mode must be online or offline" });
    if (!["1d", "2d", "1w", "permanent"].includes(duration)) {
      return res.status(400).json({ message: "duration must be 1d, 2d, 1w or permanent" });
    }

    const user = await User.findById(userId);
    if (!user || user.role !== "student") return res.status(404).json({ message: "Student not found" });

    const from = user.mode;
    const base = user.modeBase || user.mode; // already temporary → keep the real normal mode
    let until = null;
    let message = "";

    if (duration === "permanent") {
      user.mode = mode;
      user.modeBase = "";
      user.modeTempUntil = null;
      await closeActive(user._id, "cancelled");
    } else {
      if (mode === base) {
        return res.status(400).json({
          message: `This student is normally ${base}. Use "permanent" or "end now" to bring them back.`,
        });
      }
      until = untilFor(duration);
      user.mode = mode;
      user.modeBase = base;
      user.modeTempUntil = until;
      await closeActive(user._id, "cancelled"); // a new temporary change replaces the old one
      message = `Only till ${fmtDay(until)}. After that you are ${base} again.`;
    }
    await user.save();

    const log = await ModeChange.create({
      userId: user._id,
      name: user.name,
      phone: user.phone,
      onlineSection: user.onlineSection,
      englishAccess: user.englishAccess,
      hindiAccess: user.hindiAccess,
      from,
      to: mode,
      duration,
      until,
      reason: String(reason || "").slice(0, 200),
      status: duration === "permanent" ? "permanent" : "active",
      changedBy: req.user ? req.user._id : null,
      changedByName: req.user ? req.user.name || "" : "",
    });

    if (from !== user.mode || duration !== "permanent") broadcast(req.io, user, message);

    res.status(200).json({
      message:
        duration === "permanent"
          ? `${user.name} is now ${mode} (permanent)`
          : `${user.name} is ${mode} till ${fmtDay(until)}, then back to ${base}`,
      user: { _id: user._id, name: user.name, ...publicMode(user) },
      change: log,
    });
  } catch (error) {
    console.error("Change Mode Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

/** Bring one student back to the normal mode. Returns the user or null. */
const revertUser = async (user, status, io) => {
  if (!user || !user.modeBase) return null;
  user.mode = user.modeBase;
  user.modeBase = "";
  user.modeTempUntil = null;
  await user.save();
  await closeActive(user._id, status);
  broadcast(io, user, "");
  return user;
};

// POST /admin/change-mode/end
const endTempMode = async (req, res) => {
  try {
    const { userId } = req.body;
    if (!isValidId(userId)) return res.status(400).json({ message: "Valid userId required" });
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "Student not found" });
    if (!user.modeBase) return res.status(400).json({ message: "This student has no temporary change" });
    await revertUser(user, "cancelled", req.io);
    res.status(200).json({ message: `${user.name} is back to ${user.mode}`, user: { _id: user._id, ...publicMode(user) } });
  } catch (error) {
    console.error("End Temp Mode Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

/** Cron (every 5 min + at start): temporary changes whose time is over go back */
const revertExpired = async (io) => {
  try {
    const due = await User.find({ modeBase: { $in: ["online", "offline"] }, modeTempUntil: { $lte: new Date() } });
    for (const u of due) await revertUser(u, "ended", io);
    if (due.length) console.log(`🔁 ${due.length} temporary mode change(s) ended`);
    return due.length;
  } catch (e) {
    console.error("Revert temp modes failed:", e.message);
    return 0;
  }
};

// GET /admin/mode-changes
const listModeChanges = async (req, res) => {
  try {
    const status = String(req.query.status || "active").toLowerCase();
    const filter = {};
    if (status === "active") filter.status = "active";
    else if (["ended", "cancelled", "permanent"].includes(status)) filter.status = status;
    else if (status === "temporary") filter.duration = { $ne: "permanent" };

    const to = isAll(req.query.mode) ? null : normMode(req.query.mode);
    if (to) filter.to = to;

    const language = isAll(req.query.language) ? null : normLanguage(req.query.language);
    const stage = isAll(req.query.stage) ? null : normStage(req.query.stage);
    if (stage) filter[`${language === "Hindi" ? "hindiAccess" : "englishAccess"}.${stage}`] = true;
    else if (language) {
      const key = language === "Hindi" ? "hindiAccess" : "englishAccess";
      filter.$and = [{ $or: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ [`${key}.stage${n}`]: true })) }];
    }

    const q = String(req.query.q || "").trim();
    if (q) filter.$or = [{ name: new RegExp(escapeRegex(q), "i") }, { phone: new RegExp(escapeRegex(q)) }];

    const limit = Math.min(Number(req.query.limit) || 300, 1000);
    const [rows, counts] = await Promise.all([
      ModeChange.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
      ModeChange.aggregate([
        { $match: { status: "active" } },
        { $group: { _id: "$to", n: { $sum: 1 } } },
      ]),
    ]);
    const active = { online: 0, offline: 0 };
    for (const c of counts) active[c._id] = c.n;

    res.status(200).json({ total: rows.length, active, changes: rows });
  } catch (error) {
    console.error("List Mode Changes Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { changeMode, endTempMode, listModeChanges, revertExpired, _internal: { untilFor } };
