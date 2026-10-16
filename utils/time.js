// =====================================================
// IST TIME HELPERS
// The server (Render) runs in UTC. Every attendance rule is in
// India time, so ALL date/time logic must go through these helpers.
// =====================================================

const TZ = "Asia/Kolkata";
const IST_OFFSET_MIN = 330; // +05:30

const partsFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

// { year, month, day, hour, minute } in IST
const istParts = (date = new Date()) => {
  const p = {};
  for (const part of partsFormatter.formatToParts(new Date(date))) {
    p[part.type] = part.value;
  }
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
  };
};

const pad = (n) => String(n).padStart(2, "0");

// Canonical date key used everywhere: "DD-MM-YYYY" (IST)
const dateKey = (date = new Date()) => {
  const { year, month, day } = istParts(date);
  return `${pad(day)}-${pad(month)}-${year}`;
};

// Minutes since IST midnight
const istMinutesOfDay = (date = new Date()) => {
  const { hour, minute } = istParts(date);
  return hour * 60 + minute;
};

// Accepts "D-M-YYYY", "DD-MM-YYYY", "YYYY-MM-DD" → "DD-MM-YYYY" (or null)
const normalizeDateKey = (input) => {
  if (!input || typeof input !== "string") return null;
  const s = input.trim().slice(0, 10);
  let d, m, y;

  let match = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (match) {
    [, d, m, y] = match;
  } else {
    match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!match) return null;
    [, y, m, d] = match;
  }

  d = Number(d);
  m = Number(m);
  y = Number(y);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${pad(d)}-${pad(m)}-${y}`;
};

// Old records were saved in mixed formats ("5-1-2026", "05-01-2026"...)
const legacyDateVariants = (key) => {
  const [dd, mm, yyyy] = key.split("-");
  const d = String(Number(dd));
  const m = String(Number(mm));
  return [...new Set([`${dd}-${mm}-${yyyy}`, `${d}-${m}-${yyyy}`, `${dd}-${m}-${yyyy}`, `${d}-${mm}-${yyyy}`])];
};

// UTC Date range covering one IST day for a "DD-MM-YYYY" key
const istDayRange = (key) => {
  const [dd, mm, yyyy] = key.split("-").map(Number);
  const start = new Date(Date.UTC(yyyy, mm - 1, dd) - IST_OFFSET_MIN * 60000);
  const end = new Date(start.getTime() + 24 * 60 * 60000 - 1);
  return { start, end };
};

// "MM-YYYY" for the IST month (offset in months, e.g. -1 = previous month)
const monthKey = (date = new Date(), offset = 0) => {
  const { year, month } = istParts(date);
  const total = year * 12 + (month - 1) + offset;
  return `${pad((total % 12) + 1)}-${Math.floor(total / 12)}`;
};

// Parse "5:30 AM", "05:30 AM - 07:00 AM", "17:00" → minutes of day (or null)
const parseClockToMinutes = (text) => {
  if (!text || typeof text !== "string") return null;
  const match = text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const modifier = (match[3] || "").toUpperCase();
  if (modifier === "PM" && hours < 12) hours += 12;
  if (modifier === "AM" && hours === 12) hours = 0;
  return hours * 60 + minutes;
};

module.exports = {
  TZ,
  istParts,
  dateKey,
  istMinutesOfDay,
  normalizeDateKey,
  legacyDateVariants,
  istDayRange,
  monthKey,
  parseClockToMinutes,
};
