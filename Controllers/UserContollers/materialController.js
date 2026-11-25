// =====================================================
// 📚 STUDY MATERIAL (PDF per stage day) — English + Hindi, Stage 1–7
//
//   Admin:   POST   /api/materials          multipart: pdf + language, stage, day, title
//                                           (same day again = replace → version + 1)
//            DELETE /api/materials/:id
//   Everyone logged in:
//            GET    /api/materials?language=English&stage=stage6   (one stage)
//            GET    /api/materials                                 (all — tiny list)
//
// The PDF itself is on Cloudinary. Phones download each file ONCE, keep it
// offline, and only download again when the version changes.
// For 2,000 students: the list is a few KB, kept in memory for 30 s.
// =====================================================
const StudyMaterial = require("../../Models/studyMaterial");
const { uploadMaterialPdf, deleteFromCloudinary, materialDownloadUrl } = require("../../utils/cloudinary");
const { compressPdf } = require("../../utils/pdfCompress");
const { normStage, isValidId } = require("../../utils/normalize");

const PDF_MAX = 40 * 1024 * 1024; // 40 MB before compression
const LANGS = { english: "English", hindi: "Hindi" };
const cleanLang = (v) => LANGS[String(v || "").trim().toLowerCase()] || null;
const cleanDay = (v) => {
  const n = parseInt(String(v || "").replace(/[^0-9]/g, ""), 10);
  return n >= 1 && n <= 60 ? n : null;
};
const safeSigned = (publicId) => {
  try {
    return materialDownloadUrl(publicId);
  } catch (_) {
    return ""; // Cloudinary keys missing (tests) → plain link
  }
};
const view = (m) => ({
  id: String(m._id),
  language: m.language,
  stage: m.stage,
  day: m.day,
  title: m.title || "",
  subtitle: m.subtitle || "",
  // signed link → works even when Cloudinary blocks normal PDF links (401)
  url: (m.publicId && safeSigned(m.publicId)) || m.url,
  bytes: m.bytes || 0,
  version: m.version || 1,
  updatedAt: m.updatedAt,
});

// ---------- small memory cache (all materials are only a few hundred rows) ----------
let cache = null; // { at, rows }
const CACHE_MS = 30 * 1000;
const allRows = async () => {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const rows = await StudyMaterial.find({}).sort({ language: 1, stage: 1, day: 1 }).lean();
  cache = { at: Date.now(), rows };
  return rows;
};
// multi-core mode: clear the list on EVERY worker, not only this one
const bus = require("../../utils/clusterBus");
bus.on("materials.clear", () => {
  cache = null;
});
const changed = (req, payload) => {
  cache = null;
  bus.publish("materials.clear");
  if (req.io) req.io.emit("materials_updated", { at: Date.now(), ...payload });
};

// GET /api/materials?language=&stage=
const listMaterials = async (req, res) => {
  try {
    const language = cleanLang(req.query.language);
    const stage = normStage(req.query.stage);
    let rows = await allRows();
    if (language) rows = rows.filter((m) => m.language === language);
    if (stage) rows = rows.filter((m) => m.stage === stage);
    res.set("Cache-Control", "no-store");
    res.status(200).json({ success: true, materials: rows.map(view) });
  } catch (error) {
    console.error("List Materials Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// POST /api/materials  (admin)
const uploadMaterial = async (req, res) => {
  try {
    const language = cleanLang(req.body.language);
    const stage = normStage(req.body.stage);
    const day = cleanDay(req.body.day);
    const title = String(req.body.title || "").trim().slice(0, 120);
    const subtitle = String(req.body.subtitle || "").trim().slice(0, 160);
    const file = req.file;

    if (!language) return res.status(400).json({ message: "Choose English or Hindi." });
    if (!stage) return res.status(400).json({ message: "Choose a stage (1–7)." });
    if (!day) return res.status(400).json({ message: "Day must be a number from 1 to 60." });
    if (!file || !file.buffer || !file.buffer.length) return res.status(400).json({ message: "Choose a PDF file." });
    if (file.buffer.slice(0, 5).toString() !== "%PDF-") return res.status(400).json({ message: "This file is not a PDF." });
    if (file.buffer.length > PDF_MAX) return res.status(400).json({ message: "PDF too large (max 40 MB)." });

    // 🗜 compress in the middle (only when it really gets smaller)
    const { buffer, compressed } = await compressPdf(file.buffer);
    const name = `${language.toLowerCase()}_${stage}_day${day}`;
    const up = await uploadMaterialPdf(buffer, name);

    const old = await StudyMaterial.findOne({ language, stage, day }).lean();
    const doc = await StudyMaterial.findOneAndUpdate(
      { language, stage, day },
      {
        $set: {
          title: title || (old && old.title) || `Day ${day}`,
          subtitle: subtitle || (old && old.subtitle) || "",
          url: up.url,
          publicId: up.publicId,
          bytes: up.bytes,
          originalBytes: file.buffer.length,
          uploadedBy: req.user ? req.user._id : null,
          uploadedByName: req.user ? req.user.name || "" : "",
        },
        $inc: { version: 1 },
        $setOnInsert: { language, stage, day },
      },
      { upsert: true, returnDocument: "after" }
    ).lean();
    // first upload: $inc 0 → 1 • replace: version + 1 (phones see the new version)

    if (old && old.publicId && old.publicId !== up.publicId) deleteFromCloudinary(old.publicId, "raw");
    changed(req, { action: old ? "updated" : "added", language, stage, day });

    const saved = file.buffer.length - up.bytes;
    res.status(200).json({
      success: true,
      message:
        `${language} Stage ${stage.replace("stage", "")} • Day ${day} ${old ? "updated" : "added"}.` +
        (compressed && saved > 0 ? ` Compressed ${Math.round((saved / file.buffer.length) * 100)}% smaller.` : ""),
      material: view(doc),
      compressed,
    });
  } catch (error) {
    console.error("Upload Material Error:", error);
    res.status(500).json({ message: "Upload failed. Please try again." });
  }
};

// PATCH /api/materials/:id  { title }  (admin) — rename without a new file
const renameMaterial = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ message: "Invalid id" });
    const title = String(req.body.title || "").trim().slice(0, 120);
    if (!title) return res.status(400).json({ message: "Title is required." });
    const set = { title };
    if (req.body.subtitle !== undefined) set.subtitle = String(req.body.subtitle || "").trim().slice(0, 160);
    const doc = await StudyMaterial.findByIdAndUpdate(req.params.id, { $set: set }, { returnDocument: "after" }).lean();
    if (!doc) return res.status(404).json({ message: "Not found" });
    changed(req, { action: "renamed", language: doc.language, stage: doc.stage, day: doc.day });
    res.status(200).json({ success: true, material: view(doc) });
  } catch (error) {
    console.error("Rename Material Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// DELETE /api/materials/:id  (admin)
const deleteMaterial = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await StudyMaterial.findByIdAndDelete(req.params.id).lean();
    if (!doc) return res.status(200).json({ success: true, message: "Already deleted" });
    deleteFromCloudinary(doc.publicId, "raw");
    changed(req, { action: "deleted", language: doc.language, stage: doc.stage, day: doc.day });
    res.status(200).json({ success: true, message: `Day ${doc.day} deleted.` });
  } catch (error) {
    console.error("Delete Material Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { listMaterials, uploadMaterial, renameMaterial, deleteMaterial, _internal: { cleanDay, cleanLang } };
