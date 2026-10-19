// =====================================================
// TEMPORARY SECTION MERGE  (English ONLINE only — Hindi & offline have no sections)
//
// Example: Stage 1 Section B's trainer is absent today.
//   Admin merges B → A. Until someone unmerges:
//   • Section B students join Section A's live class (automatically, even if
//     they are already sitting in a class — the app moves them).
//   • Section A's trainer sees the B students (tagged "Sec B") and can do
//     practice + rating for them.
//   • Attendance and practice are still saved under Section B (the student's own section).
//   Several sections can join one host: B, C, D → A.
//   Admin unmerges (or Section B's trainer taps "I'm back") → B students go back to B.
// =====================================================
const SectionMerge = require("../../Models/sectionMerge");
const User = require("../../Models/users");
const { normStage, normSection, isValidId, ADMIN_ROLES } = require("../../utils/normalize");

const LANGUAGE = "English";
const SECTIONS = ["A", "B", "C", "D", "E"];
const isAdminUser = (u) => !!u && ADMIN_ROLES.includes(u.role);

// Old merges saved without a language → English (once per server start)
let cleaned = false;
const ensureIndexes = async () => {
  if (cleaned) return;
  cleaned = true;
  try {
    await SectionMerge.updateMany({ language: { $exists: false } }, { $set: { language: LANGUAGE } });
    await SectionMerge.deleteMany({ language: "Hindi" }); // Hindi has no sections
  } catch (_) {}
};

// ---------- helpers used by other controllers ----------

/** Section B merged into A today? → "A". Otherwise the section itself. */
const effectiveSection = async (stage, section) => {
  const sec = normSection(section);
  if (sec === "None") return { section: sec, mergedInto: null };
  let m = null;
  try {
    m = await SectionMerge.findOne({ language: LANGUAGE, stage, guestSection: sec, isActive: true }).lean();
  } catch (e) {
    console.error("Merge lookup error (using own section):", e.message);
  }
  return m ? { section: m.hostSection, mergedInto: m.hostSection, mergeId: String(m._id) } : { section: sec, mergedInto: null };
};

/** Sections merged INTO this host (["B","C"]) */
const guestsOf = async (stage, host) => {
  const rows = await SectionMerge.find({ language: LANGUAGE, stage, hostSection: normSection(host), isActive: true }).lean();
  return rows.map((m) => String(m.guestSection).toUpperCase());
};

const announce = (req, payload) => {
  if (req.io) req.io.emit("merge_updated", { language: LANGUAGE, at: Date.now(), ...payload });
};

// trainer names + student counts, so the admin sees who is affected
const enrich = async (merges) => {
  if (!merges.length) return merges;
  const stages = [...new Set(merges.map((m) => m.stage))];
  const [trainers, counts] = await Promise.all([
    User.find({ role: "teacher", language: LANGUAGE, teacherStage: { $in: stages } })
      .select("name teacherStage teacherSection mode")
      .lean(),
    (async () => {
      // students per stage + guest section (only those who have that English stage)
      const out = {};
      for (const m of merges) {
        const key = `${m.stage}|${m.guestSection}`;
        if (out[key] !== undefined) continue;
        out[key] = await User.countDocuments({
          role: "student",
          mode: "online",
          onlineSection: m.guestSection,
          [`englishAccess.${m.stage}`]: true,
        });
      }
      return out;
    })(),
  ]);
  const trainerFor = (stage, sec) => {
    const t = trainers.find(
      (x) => x.teacherStage === stage && String(x.teacherSection || "").toUpperCase() === sec && x.mode !== "offline"
    ) || trainers.find((x) => x.teacherStage === stage && String(x.teacherSection || "").toUpperCase() === sec);
    return t ? t.name : "";
  };
  return merges.map((m) => ({
    ...m,
    hostTrainer: trainerFor(m.stage, m.hostSection),
    guestTrainer: trainerFor(m.stage, m.guestSection),
    guestStudents: counts[`${m.stage}|${m.guestSection}`] || 0,
  }));
};

// =====================================================
// GET /api/admin/section-merges?stage=   (admin + trainers)
// =====================================================
const getActiveMerges = async (req, res) => {
  try {
    await ensureIndexes();
    const query = { isActive: true, language: LANGUAGE };
    const stage = normStage(req.query.stage);
    if (stage) query.stage = stage;
    const merges = await SectionMerge.find(query).sort({ stage: 1, hostSection: 1, guestSection: 1 }).lean();
    res.set("Cache-Control", "no-store");
    res.status(200).json({ success: true, merges: await enrich(merges) });
  } catch (error) {
    console.error("Get Active Merges Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// POST /api/admin/merge-sections
// { stage, hostSection: "A", guestSections: ["B","C"] }   (guestSection: "B" also works)
// =====================================================
const mergeSections = async (req, res) => {
  try {
    await ensureIndexes();
    if (req.body.language && String(req.body.language).toLowerCase() === "hindi") {
      return res.status(400).json({ message: "Hindi classes have no sections, so they can't be merged." });
    }
    const stage = normStage(req.body.stage);
    if (!stage) return res.status(400).json({ message: "Choose a stage." });

    const hostSection = normSection(req.body.hostSection);
    const rawGuests = Array.isArray(req.body.guestSections) ? req.body.guestSections : [req.body.guestSection];
    const guests = [...new Set(rawGuests.map(normSection))].filter((g) => g !== "None" && g !== hostSection);

    if (hostSection === "None") return res.status(400).json({ message: "Choose the section whose trainer is present (A–E)." });
    if (!guests.length) return res.status(400).json({ message: "Choose at least one other section to merge in." });

    const active = await SectionMerge.find({ language: LANGUAGE, stage, isActive: true }).lean();

    // The host can't itself be merged somewhere else (no chains like C → B → A)
    const hostIsGuest = active.find((m) => m.guestSection === hostSection);
    if (hostIsGuest) {
      return res.status(409).json({
        message: `Section ${hostSection} is already merged into Section ${hostIsGuest.hostSection}. Unmerge it first, or choose Section ${hostIsGuest.hostSection} as the host.`,
      });
    }
    // A guest can't be hosting other sections
    for (const g of guests) {
      const hosting = active.filter((m) => m.hostSection === g).map((m) => m.guestSection);
      if (hosting.length) {
        return res.status(409).json({
          message: `Section ${g} is hosting Section ${hosting.join(", ")} right now. Unmerge those first.`,
        });
      }
    }

    const by = req.user ? { id: req.user._id, name: req.user.name || "" } : null;
    for (const guestSection of guests) {
      await SectionMerge.findOneAndUpdate(
        { language: LANGUAGE, stage, guestSection, isActive: true },
        {
          $set: { hostSection, mergedBy: by ? by.id : null, mergedByName: by ? by.name : "" },
          $setOnInsert: { language: LANGUAGE, stage, guestSection, isActive: true },
        },
        { upsert: true, returnDocument: "after" }
      );
    }

    // ⚡ students already in class move to the host class; trainers' lists update
    announce(req, { action: "merged", stage, hostSection, guestSections: guests });

    const merges = await SectionMerge.find({ language: LANGUAGE, isActive: true }).sort({ stage: 1, hostSection: 1 }).lean();
    res.status(200).json({
      success: true,
      message: `Section ${guests.join(", ")} now ${guests.length > 1 ? "join" : "joins"} Section ${hostSection}'s class.`,
      merges: await enrich(merges),
    });
  } catch (error) {
    console.error("Merge Sections Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// DELETE /api/admin/section-merges/:id
// Admin / manager — or that stage's trainer of the guest or host section
// (e.g. Section B's trainer is back and taps "I'm back").
// =====================================================
const cancelMerge = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ message: "Invalid id" });
    const merge = await SectionMerge.findById(req.params.id).lean();
    if (!merge) return res.status(200).json({ success: true, message: "Already unmerged" });

    const u = req.user;
    if (!isAdminUser(u)) {
      const mySection = String((u && u.teacherSection) || "").toUpperCase();
      const myStage = normStage(u && u.teacherStage);
      const allowed =
        u && u.role === "teacher" && myStage === merge.stage && [merge.guestSection, merge.hostSection].includes(mySection);
      if (!allowed) return res.status(403).json({ message: "Only the admin or this class's trainer can unmerge." });
    }

    await SectionMerge.deleteOne({ _id: merge._id });
    announce(req, {
      action: "unmerged",
      stage: merge.stage,
      hostSection: merge.hostSection,
      guestSections: [merge.guestSection],
    });
    res.status(200).json({ success: true, message: `Section ${merge.guestSection} is back in its own class.` });
  } catch (error) {
    console.error("Cancel Merge Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// GET /api/admin/resolve-section?stage=&section=   (any logged-in user)
// =====================================================
const resolveEffectiveSection = async (req, res) => {
  try {
    const stage = normStage(req.query.stage) || "stage1";
    const own = normSection(req.query.section || "A");
    if (req.query.language && String(req.query.language).toLowerCase() === "hindi") {
      return res.status(200).json({ success: true, effectiveSection: own, isMerged: false });
    }
    const { section, mergedInto } = await effectiveSection(stage, own);
    res.set("Cache-Control", "no-store");
    res.status(200).json({ success: true, effectiveSection: section, isMerged: !!mergedInto, ownSection: own, mergedInto });
  } catch (error) {
    console.error("Resolve Section Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = {
  getActiveMerges,
  mergeSections,
  cancelMerge,
  resolveEffectiveSection,
  effectiveSection,
  guestsOf,
};
