const Practice = require("../../Models/practice");
const User = require("../../Models/users");
const { dateKey, normalizeDateKey } = require("../../utils/time");
const { normStage, normLanguage, isAll, isValidId } = require("../../utils/normalize");

const cleanSection = (s, language) => {
  if (language === "Hindi") return "";
  const v = String(s || "").trim().toUpperCase();
  return ["", "NONE", "ALL"].includes(v) ? "" : v;
};

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

    let userName = String(req.body.studentName || "").trim();
    if (!userName) {
      const student = await User.findById(studentId).select("name").lean();
      if (!student) return res.status(404).json({ message: "Student not found" });
      userName = student.name || "";
    }

    const trainer = req.user || null;
    const record = await Practice.findOneAndUpdate(
      key,
      {
        $set: {
          userName,
          section: cleanSection(req.body.section, language),
          trainerId: trainer ? trainer._id : null,
          trainerName: trainer ? trainer.name || "" : "",
          practicedAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    notifyAdmins(req, { type: "practice", studentId, practiced: true });
    res.status(200).json({ message: "Marked as practiced", practiced: true, record });
  } catch (error) {
    if (error && error.code === 11000) return res.status(200).json({ message: "Already marked", practiced: true });
    console.error("Mark Practice Error:", error);
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
  const rows = await Practice.find(query).select("userId language stage practicedAt trainerName").lean();
  const index = new Map();
  for (const p of rows) {
    index.set(`${p.userId}|${p.stage}|${p.language}`, p);
    if (!index.has(String(p.userId))) index.set(String(p.userId), p);
  }
  return index;
};

module.exports = { markPractice, listPractice, practiceIndex };
