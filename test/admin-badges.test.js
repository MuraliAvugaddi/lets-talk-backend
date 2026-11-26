// 🔴 admin menu badges
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_that_is_definitely_longer_than_32_chars";
const test = require("node:test");
const assert = require("node:assert/strict");

const User = require("../Models/users");
const TestDraft = require("../Models/testDraft");
const ClassRequest = require("../Models/classRequest");
const Feedback = require("../Models/feedback");
const seen = {};
User.countDocuments = async (q) => (q.feePaymentStatus ? 4 : (seen.students = q, 7));
TestDraft.countDocuments = async (q) => (q.status === "pending" ? 2 : 0);
ClassRequest.countDocuments = async (q) => (q.status === "escalated" ? 3 : 0);
Feedback.countDocuments = async (q) => (seen.fb = q, 5);

const b = require("../Controllers/UserContollers/adminBadgeController");
const call = (query) =>
  new Promise((resolve) => {
    const res = { code: 200, set() { return this; }, status(c) { this.code = c; return this; }, json(d) { resolve({ code: this.code, body: d }); } };
    b.getBadges({ query }, res);
  });

test("badges: needs access, fee screenshots, trainer tests, requests with manager, new feedback", async () => {
  b._internal.clear();
  let r = await call({ feedbackSince: "2026-11-26T10:00:00.000Z" });
  assert.equal(r.code, 200);
  assert.deepEqual(
    { s: r.body.students, f: r.body.feeVerification, t: r.body.trainerTests, q: r.body.requests, fb: r.body.feedback },
    { s: 7, f: 4, t: 2, q: 3, fb: 5 }
  );
  assert.equal(seen.fb.createdAt.$gt.toISOString(), "2026-11-26T10:00:00.000Z");
  // needs access = student, not dropout, every English + Hindi stage closed (14 checks)
  assert.equal(seen.students.role, "student");
  assert.equal(seen.students.$and.length, 14);
  r = await call({}); // never opened Feedback on this device → 0, not "all feedback ever"
  assert.equal(r.body.feedback, 0);
});

test("badges route needs an admin / manager login", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "../Routes/UserRoutes/authRoute.js"), "utf8");
  assert.match(src, /"\/admin\/badges", requireAuth\(\.\.\.ADMIN\)/);
});
