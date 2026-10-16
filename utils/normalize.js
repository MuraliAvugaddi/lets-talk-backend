// =====================================================
// INPUT NORMALIZATION
// One canonical format for stage / language / mode, plus safe
// regex escaping so query strings can never inject regex.
// =====================================================

const mongoose = require("mongoose");

const STAGE_COUNT = 7;

// "Stage 1" | "stage1" | "STAGE 1" | 1 → "stage1"  (null if invalid)
const normStage = (input) => {
  if (input === undefined || input === null) return null;
  const digits = String(input).replace(/[^0-9]/g, "");
  const n = Number(digits);
  if (!n || n < 1 || n > STAGE_COUNT) return null;
  return `stage${n}`;
};

const stageNumber = (input) => {
  const s = normStage(input);
  return s ? Number(s.replace("stage", "")) : null;
};

// Every spelling that old records may contain for a stage
const stageVariants = (input) => {
  const n = stageNumber(input);
  if (!n) return [];
  return [`stage${n}`, `Stage ${n}`, `Stage${n}`, `stage ${n}`, `STAGE ${n}`, `STAGE${n}`];
};

// "english" → "English", "HINDI" → "Hindi", anything else → null
const normLanguage = (input) => {
  if (!input) return null;
  const v = String(input).trim().toLowerCase();
  if (v === "english") return "English";
  if (v === "hindi") return "Hindi";
  return null;
};

const normMode = (input) => {
  if (!input) return null;
  const v = String(input).trim().toLowerCase();
  return v === "online" || v === "offline" ? v : null;
};

const normSection = (input) => {
  if (!input) return "None";
  const v = String(input).trim().toUpperCase();
  return ["A", "B", "C", "D", "E"].includes(v) ? v : "None";
};

const isAll = (v) => !v || String(v).trim().toLowerCase() === "all";

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isValidId = (id) => !!id && mongoose.isValidObjectId(String(id));

// Clean an access map coming from the admin app: only stage1..7 booleans survive
const cleanAccessMap = (input) => {
  if (!input || typeof input !== "object") return null;
  const out = {};
  for (let i = 1; i <= STAGE_COUNT; i++) {
    out[`stage${i}`] = input[`stage${i}`] === true;
  }
  return out;
};

const emptyAccessMap = () => cleanAccessMap({});

const STAFF_ROLES = ["teacher", "manager", "admin"];
const ADMIN_ROLES = ["manager", "admin"];

module.exports = {
  STAGE_COUNT,
  normStage,
  stageNumber,
  stageVariants,
  normLanguage,
  normMode,
  normSection,
  isAll,
  escapeRegex,
  isValidId,
  cleanAccessMap,
  emptyAccessMap,
  STAFF_ROLES,
  ADMIN_ROLES,
};
