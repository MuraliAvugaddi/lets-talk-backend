const Practice = require("../../Models/practice");
const User = require("../../Models/users");
const { dateKey, normalizeDateKey } = require("../../utils/time");
const { normStage, normLanguage, isAll, isValidId } = require("../../utils/normalize");

const cleanSection = (s, language) => {
  if (language === "Hindi") return "";
  const v = String(s || "").trim().toUpperCase();
  return ["", "NONE", "ALL"].includes(v) ? "" : v;
};

const cleanRating = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : 0;
};
const ALLOWED_TAGS = ["Fluency", "Pronunciation", "Grammar", "Vocabulary", "Confidence", "Needs practice"];

const notifyAdmins = (req, payload) => {
  if (req.io) req.io.to("admin_room").emit("attendance_update", payload);
};

// =====================================================
// TRAINER: MARK / UNDO PRACTICE
// POST /api/practice/mark
// { studentId, studentName?, language, stage, section?, practiced = true }
// =====================================================
const markPractice = async (req, res) => {
  try {
    const { studentId } = req.body;
    if (!isValidId(studentId)) return res.status(400).json({ message: "Valid studentId required" });

    const language = normLanguage(req.body.language);
    const stage = normStage(req.body.stage);
    if (!language || !stage) return res.status(400).json({ message: "language and stage are required" });

    const date = dateKey();
    const key = { userId: studentId, date, language, stage };

    // practiced:false = undo (trainer tapped by mistake)
    if (req.body.practiced === false) {
      await Practice.deleteOne(key);
      notifyAdmins(req, { type: "practice", studentId, practiced: false });
      return res.status(200).json({ message: "Practice removed", practiced: false });
    }

    // Merge day: Section A's trainer practices with Section B students →
    // the record still belongs to Section B (the student's own section).
    const student = await User.findById(studentId).select("name onlineSection").lean();
    if (!student) return res.status(404).json({ message: "Student not found" });
    const userName = String(req.body.studentName || "").trim() || student.name || "";
    const ownSection = cleanSection(student.onlineSection, language);
    const classSection = cleanSection(req.body.section, language);

    const trainer = req.user || null;
    const set = {
      userName,
      section: ownSection || classSection,
      hostSection: ownSection && classSection && classSection !== ownSection ? classSection : "",
      trainerId: trainer ? trainer._id : null,
      trainerName: trainer ? trainer.name || "" : "",
      practicedAt: new Date(),
    };
    const rating = cleanRating(req.body.rating);
    if (rating) set.rating = rating;
    const record = await Practice.findOneAndUpdate(key, { $set: set }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }).lean();

    notifyAdmins(req, { type: "practice", studentId, practiced: true });
    res.status(200).json({ message: "Marked as practiced", practiced: true, record });
  } catch (error) {
    if (error && error.code === 11000) return res.status(200).json({ message: "Already marked", practiced: true });
    console.error("Mark Practice Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// TRAINER: RATE TODAY'S PRACTICE (after "Mark practiced")
// POST /api/practice/rate { studentId, language, stage, rating: 1-5, note?, tags?: [] }
// =====================================================
const ratePractice = async (req, res) => {
  try {
    const { studentId } = req.body;
    if (!isValidId(studentId)) return res.status(400).json({ message: "Valid studentId required" });
    const language = normLanguage(req.body.language);
    const stage = normStage(req.body.stage);
    if (!language || !stage) return res.status(400).json({ message: "language and stage are required" });
    const rating = cleanRating(req.body.rating);
    if (!rating) return res.status(400).json({ message: "Rating must be 1 to 5" });

    const date = normalizeDateKey(req.body.date) || dateKey();
    const tags = Array.isArray(req.body.tags) ? req.body.tags.filter((t) => ALLOWED_TAGS.includes(t)).slice(0, 6) : [];
    const record = await Practice.findOneAndUpdate(
      { userId: studentId, date, language, stage },
      { $set: { rating, note: String(req.body.note || "").trim().slice(0, 300), tags } },
      { returnDocument: "after" }
    ).lean();
    if (!record) return res.status(404).json({ message: "Mark the student as practiced first" });

    notifyAdmins(req, { type: "practice_rating", studentId, rating });
    res.status(200).json({ message: "Rating saved", record });
  } catch (error) {
    console.error("Rate Practice Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// WHO PRACTICED (trainer screen + admin)
// GET /api/practice/list?date=&language=&stage=
// =====================================================
const listPractice = async (req, res) => {
  try {
    const date = normalizeDateKey(req.query.date) || dateKey();
    const query = { date };

    if (!isAll(req.query.language)) {
      const language = normLanguage(req.query.language);
      if (!language) return res.status(200).json({ date, total: 0, records: [] });
      query.language = language;
    }
    if (!isAll(req.query.stage)) {
      const stage = normStage(req.query.stage);
      if (stage) query.stage = stage;
    }

    const records = await Practice.find(query).sort({ practicedAt: 1 }).lean();
    res.status(200).json({ date, total: records.length, records });
  } catch (error) {
    console.error("List Practice Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// Used by the attendance sheet: Map "userId|stage|language" and "userId" → practice row
const practiceIndex = async ({ date, language, stage }) => {
  const query = { date };
  if (language) query.language = language;
  if (stage) query.stage = stage;
  const rows = await Practice.find(query).select("userId language stage practicedAt trainerName rating note tags").lean();
  const index = new Map();
  for (const p of rows) {
    index.set(`${p.userId}|${p.stage}|${p.language}`, p);
    if (!index.has(String(p.userId))) index.set(String(p.userId), p);
  }
  return index;
};

module.exports = { markPractice, ratePractice, listPractice, practiceIndex, _internal: { cleanRating } };
