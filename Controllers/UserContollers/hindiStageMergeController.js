// =====================================================
// 🔀 HINDI STAGE MERGE  (Hindi online classes — Hindi has no sections)
//
// Example: the Hindi Stage 2 trainer is absent today.
//   Admin merges Stage 2 → Stage 1. Until someone unmerges:
//   • Stage 2 students join Stage 1's live class (automatically — the app
//     moves students who are already sitting in a class).
//   • Stage 1's trainer sees the Stage 2 students (tagged "Stage 2") and can
//     do practice + rating for them.
//   • Attendance and practice are still saved under Stage 2 (their own stage).
//   Up to all 7 stages can join one host (Stage 2 … 7 → Stage 1).
//   Admin unmerges (or Stage 2's trainer taps "I'm back") → back to Stage 2.
//
// Fast for 2,000 students: the active merges (a handful of rows) are kept in
// memory for 5 s, so 2,000 students joining at once = ~1 database read.
// =====================================================
const StageMerge = require("../../Models/stageMerge");
const User = require("../../Models/users");
const { normStage, isValidId, ADMIN_ROLES } = require("../../utils/normalize");

const LANGUAGE = "Hindi";
const STAGES = ["stage1", "stage2", "stage3", "stage4", "stage5", "stage6", "stage7"];
const isAdminUser = (u) => !!u && ADMIN_ROLES.includes(u.role);
const stageName = (s) => `Stage ${String(s || "").replace(/[^0-9]/g, "")}`; // "stage2" → "Stage 2"

// ---------- small memory cache (all active Hindi merges) ----------
let cache = null; // { at, rows }
const CACHE_MS = 5000;
const activeMerges = async () => {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const rows = await StageMerge.find({ language: LANGUAGE, isActive: true }).lean();
  cache = { at: Date.now(), rows };
  return rows;
};
const forget = () => {
  cache = null;
};

// ---------- helpers used by other controllers ----------

/** Hindi Stage 2 merged into Stage 1 today? → { stage: "stage1", mergedInto: "stage1" } */
const effectiveHindiStage = async (stage) => {
  const st = normStage(stage);
  if (!st) return { stage, mergedInto: null };
  try {
    const m = (await activeMerges()).find((x) => x.guestStage === st);
    if (m) return { stage: m.hostStage, mergedInto: m.hostStage, mergeId: String(m._id) };
  } catch (e) {
    console.error("Hindi merge lookup error (using own stage):", e.message);
  }
  return { stage: st, mergedInto: null };
};

/** Stages merged INTO this host stage (["stage2","stage3"]) */
const guestStagesOf = async (host) => {
  const h = normStage(host);
  if (!h) return [];
  return (await activeMerges()).filter((m) => m.hostStage === h).map((m) => m.guestStage);
};

/** This host stage itself merged somewhere? → the merge row */
const hostOfStage = async (stage) => {
  const st = normStage(stage);
  return (await activeMerges()).find((m) => m.guestStage === st) || null;
};

/**
 * Practice / rating sent by the HOST trainer for a guest student:
 * save it under the student's OWN Hindi stage (the guest stage).
 */
const ownHindiStage = async (student, classStage) => {
  const st = normStage(classStage);
  const access = (student && student.hindiAccess) || {};
  if (!st || access[st] === true) return st; // the student's own class
  const guests = await guestStagesOf(st);
  return guests.find((g) => access[g] === true) || st;
};

const announce = (req, payload) => {
  forget();
  if (req.io) req.io.emit("merge_updated", { language: LANGUAGE, at: Date.now(), ...payload });
};

// trainer names + student counts, so the admin sees who is affected
const enrich = async (merges) => {
  if (!merges.length) return merges;
  const [trainers, counts] = await Promise.all([
    User.find({ role: "teacher", language: LANGUAGE }).select("name teacherStage").lean(),
    (async () => {
      const out = {};
      for (const g of [...new Set(merges.map((m) => m.guestStage))]) {
        out[g] = await User.countDocuments({ role: "student", [`hindiAccess.${g}`]: true });
      }
      return out;
    })(),
  ]);
  const trainerFor = (stage) => {
    const t = trainers.find((x) => normStage(x.teacherStage) === stage);
    return t ? t.name : "";
  };
  return merges.map((m) => ({
    ...m,
    hostName: stageName(m.hostStage),
    guestName: stageName(m.guestStage),
    hostTrainer: trainerFor(m.hostStage),
    guestTrainer: trainerFor(m.guestStage),
    guestStudents: counts[m.guestStage] || 0,
  }));
};

const listAll = async () =>
  enrich(await StageMerge.find({ language: LANGUAGE, isActive: true }).sort({ hostStage: 1, guestStage: 1 }).lean());

// =====================================================
// GET /api/admin/hindi-stage-merges   (admin + trainers)
// =====================================================
const getHindiMerges = async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.status(200).json({ success: true, merges: await listAll() });
  } catch (error) {
    console.error("Get Hindi Merges Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// POST /api/admin/merge-hindi-stages
// { hostStage: "stage1", guestStages: ["stage2","stage3"] }
// =====================================================
const mergeHindiStages = async (req, res) => {
  try {
    const hostStage = normStage(req.body.hostStage);
    const raw = Array.isArray(req.body.guestStages) ? req.body.guestStages : [req.body.guestStage];
    const guests = [...new Set(raw.map(normStage))].filter((g) => g && g !== hostStage);

    if (!hostStage) return res.status(400).json({ message: "Choose the stage whose trainer is present." });
    if (!guests.length) return res.status(400).json({ message: "Choose at least one other stage to merge in." });

    const active = await StageMerge.find({ language: LANGUAGE, isActive: true }).lean();

    // The host can't itself be merged somewhere else (no chains like 3 → 2 → 1)
    const hostIsGuest = active.find((m) => m.guestStage === hostStage);
    if (hostIsGuest) {
      return res.status(409).json({
        message: `${stageName(hostStage)} is already merged into ${stageName(hostIsGuest.hostStage)}. Unmerge it first, or choose ${stageName(hostIsGuest.hostStage)} as the main class.`,
      });
    }
    // A guest can't be hosting other stages
    for (const g of guests) {
      const hosting = active.filter((m) => m.hostStage === g).map((m) => stageName(m.guestStage));
      if (hosting.length) {
        return res.status(409).json({
          message: `${stageName(g)} is hosting ${hosting.join(", ")} right now. Unmerge those first.`,
        });
      }
    }

    const by = req.user ? { id: req.user._id, name: req.user.name || "" } : null;
    for (const guestStage of guests) {
      await StageMerge.findOneAndUpdate(
        { language: LANGUAGE, guestStage, isActive: true },
        {
          $set: { hostStage, mergedBy: by ? by.id : null, mergedByName: by ? by.name : "" },
          $setOnInsert: { language: LANGUAGE, guestStage, isActive: true },
        },
        { upsert: true, returnDocument: "after" }
      );
    }

    // ⚡ students already in class move to the host class; trainers' screens update
    announce(req, { action: "merged", hostStage, guestStages: guests });

    res.status(200).json({
      success: true,
      message: `${guests.map(stageName).join(", ")} now ${guests.length > 1 ? "join" : "joins"} ${stageName(hostStage)}'s Hindi class.`,
      merges: await listAll(),
    });
  } catch (error) {
    console.error("Merge Hindi Stages Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// DELETE /api/admin/hindi-stage-merges/:id
// Admin / manager — or the Hindi trainer of the guest or host stage ("I'm back").
// =====================================================
const cancelHindiMerge = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ message: "Invalid id" });
    const merge = await StageMerge.findById(req.params.id).lean();
    if (!merge) return res.status(200).json({ success: true, message: "Already unmerged" });

    const u = req.user;
    if (!isAdminUser(u)) {
      const myStage = normStage(u && u.teacherStage);
      const allowed =
        u && u.role === "teacher" && u.language === LANGUAGE && [merge.guestStage, merge.hostStage].includes(myStage);
      if (!allowed) return res.status(403).json({ message: "Only the admin or this class's trainer can unmerge." });
    }

    await StageMerge.deleteOne({ _id: merge._id });
    announce(req, { action: "unmerged", hostStage: merge.hostStage, guestStages: [merge.guestStage] });
    res.status(200).json({ success: true, message: `${stageName(merge.guestStage)} is back in its own class.` });
  } catch (error) {
    console.error("Cancel Hindi Merge Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// DELETE /api/admin/hindi-stage-merges   (admin) → unmerge ALL Hindi stages
// =====================================================
const cancelAllHindiMerges = async (req, res) => {
  try {
    const rows = await StageMerge.find({ language: LANGUAGE, isActive: true }).lean();
    if (!rows.length) return res.status(200).json({ success: true, message: "Nothing is merged." });
    await StageMerge.deleteMany({ _id: { $in: rows.map((r) => r._id) } });
    const byHost = {};
    for (const r of rows) (byHost[r.hostStage] = byHost[r.hostStage] || []).push(r.guestStage);
    for (const [hostStage, guestStages] of Object.entries(byHost)) {
      announce(req, { action: "unmerged", hostStage, guestStages });
    }
    res.status(200).json({ success: true, message: "All Hindi stages are back in their own classes." });
  } catch (error) {
    console.error("Cancel All Hindi Merges Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = {
  getHindiMerges,
  mergeHindiStages,
  cancelHindiMerge,
  cancelAllHindiMerges,
  effectiveHindiStage,
  guestStagesOf,
  hostOfStage,
  ownHindiStage,
  stageName,
  STAGES,
};
