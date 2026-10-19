// Reads the admin's special-class switches (rain day / principal class).
// Cached for a few seconds so 500 students joining at once don't hit the DB 500 times.
const ClassMode = require("../Models/classMode");

let cache = null;
let cacheAt = 0;
const TTL_MS = 5000;

const parseTime = (label) => {
  const m = String(label || "").trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const mod = (m[3] || "").toUpperCase();
  if (h > 23 || min > 59) return null;
  if (mod === "PM" && h < 12) h += 12;
  if (mod === "AM" && h === 12) h = 0;
  return h * 60 + min;
};

const formatTime = (minutes) => {
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${String(h12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${ampm}`;
};

const getModes = async ({ fresh = false } = {}) => {
  if (!fresh && cache && Date.now() - cacheAt < TTL_MS) return cache;
  const docs = await ClassMode.find({ active: true }).lean();
  cache = {
    rain: docs.find((d) => d.kind === "rain") || null,
    assembly: docs.find((d) => d.kind === "assembly") || null,
  };
  cacheAt = Date.now();
  return cache;
};

const invalidate = () => {
  cache = null;
  cacheAt = 0;
};

// Principal class arrival: on time until 15 min after the start, then late
const ASSEMBLY_GRACE_MIN = 15;
const assemblyArrival = (assembly, minutesNow) =>
  !assembly || minutesNow <= (assembly.startMinutes || 0) + ASSEMBLY_GRACE_MIN ? "Present" : "Late";

module.exports = { getModes, invalidate, parseTime, formatTime, assemblyArrival };
