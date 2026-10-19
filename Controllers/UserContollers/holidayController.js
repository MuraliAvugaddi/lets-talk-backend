// =====================================================
// 🏖 HOLIDAYS (admin)
// Admin marks "Tomorrow — Dasara" with one tap (or a range: Dasara 20–24 Oct).
//  • nobody is marked absent that day (students / trainers / everyone)
//  • the day is NOT a working day in reports → trainer salary is not confused
//  • best-student attendance % does not drop
// =====================================================
const Holiday = require("../../Models/holiday");
const { dateKey, normalizeDateKey } = require("../../utils/time");
const { clearHolidayCache, publicHoliday } = require("../../utils/holidays");

const MAX_DAYS = 62; // one request can cover a 2-month vacation at most
const APPLIES = ["all", "students", "trainers"];

const toNum = (key) => {
  const [d, m, y] = key.split("-").map(Number);
  return y * 10000 + m * 100 + d;
};
const keyToUtc = (key) => {
  const [d, m, y] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const utcToKey = (ms) => {
  const dt = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(dt.getUTCDate())}-${p(dt.getUTCMonth() + 1)}-${dt.getUTCFullYear()}`;
};

const announce = (req, payload) => {
  if (req.io) req.io.emit("holiday_updated", { at: Date.now(), ...payload });
};

// GET /api/admin/holidays?year=2026  (or ?from=DD-MM-YYYY&to=DD-MM-YYYY)   — any logged-in user
const listHolidays = async (req, res) => {
  try {
    const rows = await Holiday.find({}).lean();
    const year = Number(req.query.year) || null;
    const from = normalizeDateKey(req.query.from);
    const to = normalizeDateKey(req.query.to);
    const today = dateKey();
    const list = rows
      .filter((h) => normalizeDateKey(h.date))
      .filter((h) => !year || h.date.endsWith(`-${year}`))
      .filter((h) => !from || toNum(h.date) >= toNum(from))
      .filter((h) => !to || toNum(h.date) <= toNum(to))
      .sort((a, b) => toNum(a.date) - toNum(b.date))
      .map((h) => ({ ...publicHoliday(h), past: toNum(h.date) < toNum(today), today: h.date === today }));
    res.set("Cache-Control", "no-store");
    res.status(200).json({ today, holidays: list });
  } catch (error) {
    console.error("List Holidays Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// POST /api/admin/holidays { from: "20-10-2026", to?: "24-10-2026", title: "Dasara", appliesTo: "all" }
const addHolidays = async (req, res) => {
  try {
    const from = normalizeDateKey(req.body.from || req.body.date);
    const to = normalizeDateKey(req.body.to) || from;
    if (!from) return res.status(400).json({ message: "Choose a date." });
    if (toNum(to) < toNum(from)) return res.status(400).json({ message: "End date is before start date." });

    const days = Math.round((keyToUtc(to) - keyToUtc(from)) / 86400000) + 1;
    if (days > MAX_DAYS) return res.status(400).json({ message: `At most ${MAX_DAYS} days at once.` });

    const title = String(req.body.title || "Holiday").trim().slice(0, 60) || "Holiday";
    const appliesTo = APPLIES.includes(req.body.appliesTo) ? req.body.appliesTo : "all";
    const by = req.user ? { id: req.user._id, name: req.user.name || "" } : { id: null, name: "" };

    const dates = [];
    for (let i = 0; i < days; i++) dates.push(utcToKey(keyToUtc(from) + i * 86400000));

    await Holiday.bulkWrite(
      dates.map((date) => ({
        updateOne: {
          filter: { date },
          update: { $set: { title, appliesTo, createdBy: by.id, createdByName: by.name }, $setOnInsert: { date } },
          upsert: true,
        },
      })),
      { ordered: false }
    );
    clearHolidayCache();
    announce(req, { action: "added", dates, title, appliesTo });

    res.status(200).json({
      success: true,
      message: days === 1 ? `${from} is now a holiday (${title}).` : `${days} days marked as holiday (${title}).`,
      dates,
    });
  } catch (error) {
    console.error("Add Holiday Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// DELETE /api/admin/holidays/:id
const removeHoliday = async (req, res) => {
  try {
    const h = await Holiday.findById(req.params.id).lean().catch(() => null);
    if (!h) return res.status(200).json({ success: true, message: "Already removed" });
    await Holiday.deleteOne({ _id: h._id });
    clearHolidayCache();
    announce(req, { action: "removed", dates: [h.date] });
    res.status(200).json({ success: true, message: `${h.date} is a working day again.` });
  } catch (error) {
    console.error("Remove Holiday Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { listHolidays, addHolidays, removeHoliday, _internal: { utcToKey, keyToUtc, toNum } };
