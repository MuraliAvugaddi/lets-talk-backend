// The 7 daily class timings (IST). Single source of truth for the backend.
// Stored on users as the canonical `label` (e.g. "05:30 AM - 07:00 AM").
const BATCHES = [
  { id: "batch1", number: 1, label: "05:30 AM - 07:00 AM", period: "AM", start: 5 * 60 + 30 },
  { id: "batch2", number: 2, label: "07:00 AM - 08:30 AM", period: "AM", start: 7 * 60 },
  { id: "batch3", number: 3, label: "09:00 AM - 10:30 AM", period: "AM", start: 9 * 60 },
  { id: "batch4", number: 4, label: "10:30 AM - 12:00 PM", period: "AM", start: 10 * 60 + 30 },
  { id: "batch5", number: 5, label: "03:30 PM - 05:00 PM", period: "PM", start: 15 * 60 + 30 },
  { id: "batch6", number: 6, label: "05:00 PM - 06:30 PM", period: "PM", start: 17 * 60 },
  { id: "batch7", number: 7, label: "06:30 PM - 08:00 PM", period: "PM", start: 18 * 60 + 30 },
];

const BY_START = new Map(BATCHES.map((b) => [b.start, b]));

// Accepts anything the apps may send and returns the canonical batch (or null):
//   "batch3" | 3 | "3" | "09:00 AM - 10:30 AM" | "9:00 AM - 10:30 AM" | "9:00 AM" | "03:30 - 05:00"
const findBatch = (input) => {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim();
  if (!raw || ["all", "none", "n/a", "live stream"].includes(raw.toLowerCase())) return null;

  const idMatch = raw.match(/^batch\s*([1-7])$/i) || raw.match(/^([1-7])$/);
  if (idMatch) return BATCHES[Number(idMatch[1]) - 1];

  const m = raw.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const mod = (m[3] || "").toUpperCase();
  if (mod === "PM" && h < 12) h += 12;
  if (mod === "AM" && h === 12) h = 0;

  // No AM/PM written (poster style "03:30 - 05:00"): try as-is, then as PM
  return BY_START.get(h * 60 + min) || (!mod && h < 12 ? BY_START.get((h + 12) * 60 + min) : null) || null;
};

const normBatch = (input) => {
  const b = findBatch(input);
  return b ? b.label : null;
};

// ---------------------------------------------------------------------
// PER-STAGE TIMINGS
// A student can be in two stages at once (e.g. finishing Stage 1 at 5:30 AM
// while starting Stage 2 at 3:30 PM). So each enabled stage has its own timing:
//   user.englishBatch.stage1 = "05:30 AM - 07:00 AM"
//   user.englishBatch.stage2 = "03:30 PM - 05:00 PM"
// user.batchTime is the default (chosen at signup) for stages without their own.
// ---------------------------------------------------------------------
const STAGE_KEYS = ["stage1", "stage2", "stage3", "stage4", "stage5", "stage6", "stage7"];
const LANGS = [
  { language: "English", access: "englishAccess", batch: "englishBatch" },
  { language: "Hindi", access: "hindiAccess", batch: "hindiBatch" },
];

const batchFieldFor = (language) => (String(language).toLowerCase() === "hindi" ? "hindiBatch" : "englishBatch");

// Returns a clean { stage1: label|"" ... } map, or null if input is not an object
const cleanBatchMap = (input) => {
  if (!input || typeof input !== "object") return null;
  const out = {};
  for (const k of STAGE_KEYS) out[k] = normBatch(input[k]) || "";
  return out;
};

const emptyBatchMap = () => cleanBatchMap({});

// The timing a student attends for one language + stage
const stageBatch = (user, language, stage) => {
  if (!user) return "";
  const map = user[batchFieldFor(language)] || {};
  return normBatch(map[stage]) || normBatch(user.batchTime) || "";
};

// Every enabled stage with its effective timing
const enabledStageTimings = (user) => {
  const out = [];
  for (const L of LANGS) {
    const access = user[L.access] || {};
    for (const k of STAGE_KEYS) {
      if (access[k] === true) out.push({ language: L.language, stage: k, batch: stageBatch(user, L.language, k) });
    }
  }
  return out;
};

// Two enabled stages at the same time is impossible for one student.
// Returns a readable message for the first clash, or null.
const findBatchConflict = (user) => {
  const seen = new Map();
  let defaultUsed = false;
  for (const t of enabledStageTimings(user)) {
    if (!t.batch) continue;
    // Stages with no timing of their own share the signup default. Older students may have
    // several such stages — treat that as "timing still to be set", not a clash.
    const explicit = normBatch((user[batchFieldFor(t.language)] || {})[t.stage]);
    if (!explicit) {
      if (defaultUsed) continue;
      defaultUsed = true;
    }
    const prev = seen.get(t.batch);
    const name = `${t.language} ${t.stage.replace("stage", "Stage ")}`;
    if (prev) {
      const b = findBatch(t.batch);
      return `${prev} and ${name} are both at ${b ? b.label : t.batch}. Choose a different timing for one of them.`;
    }
    seen.set(t.batch, name);
  }
  return null;
};

// ---------------------------------------------------------------------
// JOIN WINDOW — a student may join their own batch from 30 min before it
// starts until 15 min after it ends. Joining any other time = "other batch".
// ---------------------------------------------------------------------
const BATCH_LENGTH_MIN = 90;
const EARLY_JOIN_MIN = Number(process.env.BATCH_EARLY_JOIN_MIN || 30);
const LATE_GRACE_MIN = Number(process.env.BATCH_LATE_GRACE_MIN || 15);

const inBatchWindow = (label, minutes) => {
  const b = findBatch(label);
  if (!b) return true; // no timing set → can't judge, allow
  return minutes >= b.start - EARLY_JOIN_MIN && minutes <= b.start + BATCH_LENGTH_MIN + LATE_GRACE_MIN;
};

// The batch running at this IST minute (or starting within 30 min), else null
const batchAt = (minutes) =>
  BATCHES.find((b) => minutes >= b.start && minutes < b.start + BATCH_LENGTH_MIN) ||
  BATCHES.find((b) => minutes >= b.start - EARLY_JOIN_MIN && minutes < b.start) ||
  null;

module.exports = {
  inBatchWindow,
  batchAt,
  BATCHES,
  STAGE_KEYS,
  findBatch,
  normBatch,
  batchFieldFor,
  cleanBatchMap,
  emptyBatchMap,
  stageBatch,
  enabledStageTimings,
  findBatchConflict,
};
