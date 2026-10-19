// 🏖 Holidays — tiny collection, cached in memory (refreshed every minute or on change)
const Holiday = require("../Models/holiday");

const TTL_MS = 60 * 1000;
let cache = null;
let cacheAt = 0;

const loadHolidays = async () => {
  if (cache && Date.now() - cacheAt < TTL_MS) return cache;
  try {
    const rows = await Holiday.find({}).lean();
    cache = new Map(rows.map((h) => [h.date, h]));
  } catch (e) {
    console.error("Holiday load error:", e.message);
    cache = cache || new Map();
  }
  cacheAt = Date.now();
  return cache;
};

const clearHolidayCache = () => {
  cache = null;
  cacheAt = 0;
};

// role: "student" | "teacher" | "manager" | "admin"
const holidayApplies = (h, role) => {
  if (!h) return false;
  if (h.appliesTo === "students") return role === "student";
  if (h.appliesTo === "trainers") return role !== "student";
  return true;
};

/** The holiday for this date + role, or null */
const holidayFor = async (dateKey, role = "student") => {
  const map = await loadHolidays();
  const h = map.get(dateKey);
  return holidayApplies(h, role) ? h : null;
};

/** Raw holiday for a date (any role) */
const holidayOn = async (dateKey) => (await loadHolidays()).get(dateKey) || null;

const publicHoliday = (h) =>
  h ? { _id: String(h._id), date: h.date, title: h.title || "Holiday", appliesTo: h.appliesTo || "all" } : null;

module.exports = { loadHolidays, clearHolidayCache, holidayApplies, holidayFor, holidayOn, publicHoliday };
