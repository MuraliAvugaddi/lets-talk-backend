const SectionMerge = require("../../Models/sectionMerge");

const getActiveMerges = async (req, res) => {
  try {
    const merges = await SectionMerge.find({ isActive: true }).lean();
    res.status(200).json({ success: true, merges });
  } catch (error) {
    console.error("Get Active Merges Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const mergeSections = async (req, res) => {
  try {
    let { language, stage, hostSection, guestSection } = req.body;
    stage = stage ? stage.toString().toLowerCase().replace(/\s+/g, "") : "stage1";

    let existing = await SectionMerge.findOne({ language, stage, guestSection, isActive: true });
    if (existing) {
      existing.hostSection = hostSection;
      await existing.save();
    } else {
      existing = await SectionMerge.create({ language, stage, hostSection, guestSection, isActive: true });
    }

    if (req.io) {
      req.io.emit('merge_updated', { language, stage, hostSection, guestSection });
    }

    res.status(200).json({ success: true, message: "Sections merged successfully", merge: existing });
  } catch (error) {
    console.error("Merge Sections Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const cancelMerge = async (req, res) => {
  try {
    const { id } = req.params;
    await SectionMerge.findByIdAndDelete(id);

    if (req.io) {
      req.io.emit('merge_updated', { cancelled: true });
    }

    res.status(200).json({ success: true, message: "Merge cancelled successfully" });
  } catch (error) {
    console.error("Cancel Merge Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const resolveEffectiveSection = async (req, res) => {
  try {
    const { language, stage, section } = req.query;
    const cleanStage = stage ? stage.toString().toLowerCase().replace(/\s+/g, "") : "stage1";
    const cleanSection = section ? section.toString().toUpperCase().trim() : "A";

    const merge = await SectionMerge.findOne({
      language: { $regex: new RegExp(`^${language || 'English'}$`, "i") },
      stage: cleanStage,
      guestSection: cleanSection,
      isActive: true,
    }).lean();

    const effectiveSection = merge ? merge.hostSection : cleanSection;
    res.status(200).json({ success: true, effectiveSection, isMerged: !!merge });
  } catch (error) {
    console.error("Resolve Section Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { getActiveMerges, mergeSections, cancelMerge, resolveEffectiveSection };