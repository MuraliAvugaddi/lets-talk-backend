// =====================================================
// 🎓 STAGE ACCESS — one place for the rules
//
//   englishAccess / hindiAccess = the student's CURRENT stage(s)
//        → live class, attendance, weekly tests, reminders, notifications
//   englishDone   / hindiDone   = stages the student FINISHED (or had when dropped out)
//        → only the study material can be opened. No live class, no attendance.
//
//   Promote Stage 1 → 2 : access.stage1 = false, done.stage1 = true, access.stage2 = true
//   Dropout             : done = done + access, access = all off  (material only)
//   Rejoin              : access + done given back exactly as before the dropout
// =====================================================
const STAGES = ["stage1", "stage2", "stage3", "stage4", "stage5", "stage6", "stage7"];

const fields = (language) =>
  language === "Hindi"
    ? { access: "hindiAccess", done: "hindiDone", batch: "hindiBatch" }
    : { access: "englishAccess", done: "englishDone", batch: "englishBatch" };

/** mongoose sub-document / plain object / null → { stage1: bool … stage7: bool } */
const plain = (m) => {
  const src = m && typeof m.toObject === "function" ? m.toObject() : m || {};
  return Object.fromEntries(STAGES.map((s) => [s, src[s] === true]));
};
const allOff = () => Object.fromEntries(STAGES.map((s) => [s, false]));
const anyOn = (m) => STAGES.some((s) => plain(m)[s]);
const highestOn = (m) => {
  const p = plain(m);
  return [...STAGES].reverse().find((s) => p[s]) || null;
};
const nextStage = (stage) => {
  const i = STAGES.indexOf(stage);
  return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null;
};
const label = (language, stage) => `${language === "Hindi" ? "Hindi" : "English"} ${String(stage).replace("stage", "Stage ")}`;

/** live class / attendance allowed for this stage? */
const isLive = (user, language, stage) => !!user && !user.isDropout && plain(user[fields(language).access])[stage];
/** study material allowed for this stage? */
const hasMaterial = (user, language, stage) =>
  !!user && (plain(user[fields(language).access])[stage] || plain(user[fields(language).done])[stage]);

/**
 * Why a STUDENT may not join the live class / mark attendance for this stage.
 * null = allowed. Staff are never blocked. ENFORCE_STAGE_ACCESS=false switches the check off.
 */
const liveBlockReason = (user, language, stage, { assembly = false } = {}) => {
  if (process.env.ENFORCE_STAGE_ACCESS === "false") return null;
  if (!user || user.role !== "student") return null;
  if (user.isDropout) {
    return "Your classes are paused. You can still read your study material. Please contact the institute to rejoin.";
  }
  if (assembly) return null; // special class: every active student may join
  if (isLive(user, language, stage)) return null;
  if (plain(user[fields(language).done])[stage]) {
    return `You finished ${label(language, stage)}. Its study material stays open, but the live class and attendance are in your new stage now.`;
  }
  return `${label(language, stage)} is not open for you.`;
};

/** Stage done → access off. Called after every access change so both maps never say "on" together. */
const tidy = (user) => {
  for (const language of ["English", "Hindi"]) {
    const f = fields(language);
    const access = plain(user[f.access]);
    const done = plain(user[f.done]);
    for (const s of STAGES) if (access[s]) done[s] = false;
    user[f.done] = done;
  }
};

module.exports = { STAGES, fields, plain, allOff, anyOn, highestOn, nextStage, label, isLive, hasMaterial, liveBlockReason, tidy };
