// =====================================================
// 🔴 ADMIN MENU BADGES — "what needs me?" counts for the side menu
//   GET /api/admin/badges?feedbackSince=<ISO date>
//   → { students, feeVerification, trainerTests, requests, feedback }
//
//   students         new students waiting for stage access (not dropouts)
//   feeVerification  fee screenshots waiting to be checked
//   trainerTests     tests trainers sent for approval
//   requests         student requests the trainer sent to the manager
//   feedback         feedback written after the admin last opened Feedback
//
// Cached 5 s (several admins / tabs polling = a few small counts, not a load).
// =====================================================
const User = require("../../Models/users");
const TestDraft = require("../../Models/testDraft");
const ClassRequest = require("../../Models/classRequest");
const Feedback = require("../../Models/feedback");
const { STAGES } = require("../../utils/stageAccess");

const CACHE_MS = 5 * 1000;
let cache = null; // { at, data }

/** students with NO current English or Hindi stage open */
const needsAccessFilter = () => ({
  role: "student",
  isDropout: { $ne: true },
  $and: STAGES.flatMap((s) => [{ [`englishAccess.${s}`]: { $ne: true } }, { [`hindiAccess.${s}`]: { $ne: true } }]),
});

const counts = async () => {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const [students, feeVerification, trainerTests, requests] = await Promise.all([
    User.countDocuments(needsAccessFilter()),
    User.countDocuments({ role: "student", feePaymentStatus: "pending_verification" }),
    TestDraft.countDocuments({ status: "pending" }),
    ClassRequest.countDocuments({ status: "escalated" }),
  ]);
  const data = { students, feeVerification, trainerTests, requests };
  cache = { at: Date.now(), data };
  return data;
};

const getBadges = async (req, res) => {
  try {
    const data = { ...(await counts()) };
    // feedback: new since this admin last looked (the app remembers that time)
    const since = new Date(String(req.query.feedbackSince || ""));
    data.feedback = isNaN(since) ? 0 : await Feedback.countDocuments({ createdAt: { $gt: since } });
    res.set("Cache-Control", "no-store");
    res.status(200).json({ success: true, ...data });
  } catch (error) {
    console.error("Admin badges error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { getBadges, _internal: { needsAccessFilter, clear: () => (cache = null) } };
