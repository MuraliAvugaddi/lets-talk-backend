const SectionMerge = require("../../Models/sectionMerge");
const { normStage, normLanguage, normSection, isValidId } = require("../../utils/normalize");

const getActiveMerges = async (req, res) => {
  try {
    const merges = await SectionMerge.find({ isActive: true }).lean();
    res.status(200).json({ success: true, merges });
  } catch (error) {
    console.error("Get Active Merges Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// POST /api/admin/merge-sections { language, stage, hostSection, guestSection }
const mergeSections = async (req, res) => {
  try {
    const language = normLanguage(req.body.language) || "English";
    const stage = normStage(req.body.stage) || "stage1";
    const hostSection = normSection(req.body.hostSection);
    const guestSection = normSection(req.body.guestSection);

    if (hostSection === "None" || guestSection === "None" || hostSection === guestSection) {
      return res.status(400).json({ message: "Choose two different sections (A-E)." });
    }

    const merge = await SectionMerge.findOneAndUpdate(
      { language, stage, guestSection, isActive: true },
      { $set: { hostSection }, $setOnInsert: { language, stage, guestSection, isActive: true } },
      { upsert: true, new: true }
    );

    if (req.io) req.io.emit("merge_updated", { language, stage, hostSection, guestSection });

    res.status(200).json({ success: true, message: "Sections merged successfully", merge });
  } catch (error) {
    console.error("Merge Sections Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const cancelMerge = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ message: "Invalid id" });
    await SectionMerge.findByIdAndDelete(req.params.id);
    if (req.io) req.io.emit("merge_updated", { cancelled: true });
    res.status(200).json({ success: true, message: "Merge cancelled successfully" });
  } catch (error) {
    console.error("Cancel Merge Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// GET /api/admin/resolve-section?language=&stage=&section=
const resolveEffectiveSection = async (req, res) => {
  try {
    const language = normLanguage(req.query.language) || "English";
    const stage = normStage(req.query.stage) || "stage1";
    const section = normSection(req.query.section || "A");

    const merge = await SectionMerge.findOne({ language, stage, guestSection: section, isActive: true }).lean();
    res.status(200).json({ success: true, effectiveSection: merge ? merge.hostSection : section, isMerged: !!merge });
  } catch (error) {
    console.error("Resolve Section Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { getActiveMerges, mergeSections, cancelMerge, resolveEffectiveSection };
