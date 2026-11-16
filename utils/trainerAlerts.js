// =====================================================
// 👋 TRAINER ALERTS — "a new student joined YOUR class"
//
// When the admin / online manager gives a student a class (stage access,
// section, timing), promotes them, rejoins a dropout or changes online/offline,
// every trainer of that class gets:
//   • a push notification on the phone
//   • a live pop-up in the trainer app (socket "new_student")
//   • an entry in the trainer app's bell list (GET /api/trainer/alerts)
//
// Example: Venkat gets English Stage 1, Section A, 05:30 AM - 07:00 AM
//   → trainer Ramesh (English • Stage 1 • Section A) gets:
//     "👋 New student: Venkat"
//     "Online manager Priya added Venkat to your class — English Stage 1 • Section A • 05:30 AM - 07:00 AM"
// Runs in the background: never slows down or breaks the admin's request.
// =====================================================
const User = require("../Models/users");
const TrainerAlert = require("../Models/trainerAlert");
const push = require("./push");
const { enabledStageTimings } = require("./batches");

const sec = (s) => {
  const v = String(s || "").trim().toUpperCase();
  return v && v !== "NONE" ? v : "";
};

/** The live classes a student is in right now (one per language + stage). */
const classesOf = (user) => {
  if (!user || user.role !== "student" || user.isDropout) return [];
  const mode = user.mode === "offline" ? "offline" : "online";
  return enabledStageTimings(user).map((t) => ({
    language: t.language,
    stage: t.stage,
    batch: t.batch || "",
    mode,
    // sections exist only for English online classes
    section: t.language === "English" && mode === "online" ? sec(user.onlineSection) : "",
  }));
};

const keyOf = (c) => [c.language, c.stage, c.mode, c.section, c.batch].join("|");

const stageLabel = (stage) => String(stage || "").replace(/stage/i, "Stage ");

const classLabel = (c) =>
  [`${c.language} ${stageLabel(c.stage)}`, c.section ? `Section ${c.section}` : "", c.batch || "", c.mode === "offline" ? "Offline" : ""]
    .filter(Boolean)
    .join(" • ");

const byLabel = (by) => {
  if (!by) return "The admin";
  const name = String(by.name || "").trim();
  if (by.role === "manager") return `${by.mode === "offline" ? "Offline" : "Online"} manager${name ? ` ${name}` : ""}`;
  if (by.role === "admin") return `Admin${name ? ` ${name}` : ""}`;
  return name || "The admin";
};

const DURATION = { "1d": "for 1 day", "2d": "for 2 days", "1w": "for 1 week" };
const fmtDay = (d) =>
  new Date(d).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
/** "for 2 days (till Sun, 16 Nov)" — only when the change is temporary */
const periodText = (extra) =>
  extra && extra.until ? `${DURATION[extra.duration] || "for a few days"} (till ${fmtDay(extra.until)})` : "";

const verb = {
  added: "added",
  promoted: "promoted",
  rejoined: "brought back",
  mode: "moved",
};

/** Trainers who teach this class (same language, stage, mode; English online → same section). */
const trainersFor = async (c) => {
  const q = {
    role: "teacher",
    language: c.language,
    teacherStage: { $regex: `^stage\\s*${String(c.stage).replace(/\D/g, "")}$`, $options: "i" },
  };
  const list = await User.find(q).select("_id name mode teacherSection").lean();
  return list.filter((t) => {
    const tMode = t.mode === "offline" ? "offline" : "online";
    if (c.language === "English" && tMode !== c.mode) return false;
    if (c.section) return sec(t.teacherSection) === c.section;
    return true;
  });
};

/**
 * Tell the trainers about classes this student did NOT have before.
 *   before = classesOf(user) taken BEFORE the change
 *   reason = added | promoted | rejoined | mode
 *   extra  = { duration: "2d", until: Date } → online/offline only for some days
 */
const studentAdded = (req, student, before = [], reason = "added", extra = null) => {
  if (!student) return;
  const had = new Set((before || []).map(keyOf));
  const fresh = classesOf(student).filter((c) => !had.has(keyOf(c)));
  if (!fresh.length) return;
  const by = req && req.user ? { name: req.user.name, role: req.user.role, mode: req.user.mode } : null;
  const io = req && req.io;
  const studentId = student._id;
  const name = String(student.name || "Student").trim();
  const period = periodText(extra); // phone number is never shared with trainers

  push.later(async () => {
    for (const c of fresh) {
      const trainers = await trainersFor(c);
      if (!trainers.length) continue;
      const what = classLabel(c);
      const body = `${byLabel(by)} ${verb[reason] || "added"} ${name} to your class${period ? ` ${period}` : ""} — ${what}`;

      const docs = await TrainerAlert.insertMany(
        trainers.map((t) => ({
          trainerId: t._id,
          studentId,
          studentName: name,
          language: c.language,
          stage: c.stage,
          section: c.section,
          batch: c.batch,
          mode: c.mode,
          reason,
          duration: extra && extra.until ? String(extra.duration || "") : "",
          until: extra && extra.until ? extra.until : null,
          byName: by ? String(by.name || "") : "",
          byRole: by ? String(by.role || "") : "",
        }))
      );

      // 🔴 live pop-up in the trainer app (if it is open)
      if (io) {
        docs.forEach((d) =>
          io.to(String(d.trainerId)).emit("new_student", { ...d.toObject(), title: `👋 New student: ${name}`, body })
        );
      }

      // 🔔 phone notification
      await push.toUsers(
        trainers.map((t) => t._id),
        {
          title: `👋 New student: ${name}`,
          body,
          data: { click: "alerts", type: "new_student", studentId: String(studentId) },
        }
      );
    }
  });
};

module.exports = { classesOf, studentAdded, classLabel };
