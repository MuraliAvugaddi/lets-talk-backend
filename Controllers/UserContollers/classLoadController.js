const User = require("../../Models/users");
const { BATCHES, STAGE_KEYS, normBatch } = require("../../utils/batches");

// CLASS LOAD — students per stage / section / timing (admin Student Control screen)
// GET /api/admin/class-load?exclude=<userId>

const SECTIONS = ["A", "B", "C", "D", "E"];
const LANGS = [
  { language: "English", access: "englishAccess", batch: "englishBatch" },
  { language: "Hindi", access: "hindiAccess", batch: "hindiBatch" },
];

const emptyStage = (withSections) => {
  const s = { total: 0, timings: {} };
  for (const b of BATCHES) s.timings[b.label] = 0;
  s.noTiming = 0;
  if (withSections) {
    s.sections = {};
    s.matrix = {};
    for (const sec of SECTIONS) {
      s.sections[sec] = 0;
      s.matrix[sec] = {};
      for (const b of BATCHES) s.matrix[sec][b.label] = 0;
    }
    s.noSection = 0;
  }
  return s;
};

const summarizeLoad = (students, excludeId = "") => {
  const out = { online: {}, offline: {} };
  for (const mode of ["online", "offline"]) {
    for (const L of LANGS) {
      out[mode][L.language] = {};
      for (const k of STAGE_KEYS) {
        out[mode][L.language][k] = emptyStage(mode === "online" && L.language === "English");
      }
    }
  }

  for (const u of students) {
    if (excludeId && String(u._id) === String(excludeId)) continue;
    const mode = String(u.mode || "").toLowerCase() === "offline" ? "offline" : "online";
    const section = String(u.onlineSection || "").toUpperCase();

    for (const L of LANGS) {
      const access = u[L.access] || {};
      const batches = u[L.batch] || {};
      for (const k of STAGE_KEYS) {
        if (access[k] !== true) continue;
        const s = out[mode][L.language][k];
        const timing = normBatch(batches[k]) || normBatch(u.batchTime) || "";
        s.total += 1;
        if (timing) s.timings[timing] += 1;
        else s.noTiming += 1;
        if (s.sections) {
          if (SECTIONS.includes(section)) {
            s.sections[section] += 1;
            if (timing) s.matrix[section][timing] += 1;
          } else {
            s.noSection += 1;
          }
        }
      }
    }
  }
  return out;
};

const getClassLoad = async (req, res) => {
  try {
    const [students, trainers] = await Promise.all([
      User.find({ role: "student" })
        .select("mode onlineSection batchTime englishBatch hindiBatch englishAccess hindiAccess")
        .lean(),
      User.find({ role: "teacher" }).select("name language teacherStage teacherSection").lean(),
    ]);

    const load = summarizeLoad(students, req.query.exclude);

    const trainerMap = {};
    for (const t of trainers) {
      const lang = String(t.language || "English").toLowerCase() === "hindi" ? "Hindi" : "English";
      const stage = String(t.teacherStage || "").toLowerCase();
      const sec = String(t.teacherSection || "").toUpperCase();
      if (!STAGE_KEYS.includes(stage)) continue;
      trainerMap[lang] = trainerMap[lang] || {};
      trainerMap[lang][stage] = trainerMap[lang][stage] || {};
      const key = SECTIONS.includes(sec) ? sec : "all";
      trainerMap[lang][stage][key] = trainerMap[lang][stage][key]
        ? trainerMap[lang][stage][key] + ", " + t.name
        : t.name;
    }

    res.status(200).json({
      sections: SECTIONS,
      timings: BATCHES.map((b) => b.label),
      ...load,
      trainers: trainerMap,
    });
  } catch (error) {
    console.error("Class load error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { getClassLoad, _internal: { summarizeLoad } };
