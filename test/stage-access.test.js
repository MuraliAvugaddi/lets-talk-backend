// 🎓 Promote / finished stages / dropout — who may join the live class, who sees material
process.env.TZ = "Asia/Kolkata";
process.env.JWT_SECRET = "test_secret_that_is_definitely_longer_than_32_chars";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/never-used";
process.env.ENFORCE_AUTH = "false";

const test = require("node:test");
const assert = require("node:assert/strict");
const sa = require("../utils/stageAccess");
const { promoteOne } = require("../Controllers/UserContollers/promotionController")._internal;

const on = (...stages) => Object.fromEntries(sa.STAGES.map((s) => [s, stages.includes(s)]));
const student = (extra = {}) => ({
  role: "student",
  language: "English",
  englishAccess: on("stage1"),
  hindiAccess: on(),
  englishDone: on(),
  hindiDone: on(),
  englishBatch: { stage1: "05:30 AM - 07:00 AM" },
  ...extra,
});

test("promote Stage 1 → 2: stage 1 = material only, stage 2 = live, timing moves along", () => {
  const u = student();
  const r = promoteOne(u, "English", "stage1");
  assert.deepEqual(r, { from: "stage1", to: "stage2" });
  assert.equal(u.englishAccess.stage1, false);
  assert.equal(u.englishDone.stage1, true);
  assert.equal(u.englishAccess.stage2, true);
  assert.equal(u.englishBatch.stage2, "05:30 AM - 07:00 AM");
  assert.equal(u.englishBatch.stage1, "");

  assert.equal(sa.liveBlockReason(u, "English", "stage2"), null);
  assert.match(sa.liveBlockReason(u, "English", "stage1"), /You finished English Stage 1/);
  assert.equal(sa.hasMaterial(u, "English", "stage1"), true);
  assert.equal(sa.hasMaterial(u, "English", "stage2"), true);
  assert.equal(sa.hasMaterial(u, "English", "stage3"), false);
});

test("promote without a stage uses the highest current stage; stage 7 = course finished", () => {
  const u = student({ englishAccess: on("stage7"), englishBatch: {} });
  const r = promoteOne(u, "English", null);
  assert.deepEqual(r, { from: "stage7", to: null });
  assert.equal(sa.anyOn(u.englishAccess), false);
  assert.equal(u.englishDone.stage7, true);
});

test("two stages at two timings: finishing Stage 1 keeps Stage 2 and its own timing", () => {
  const u = student({
    englishAccess: on("stage1", "stage2"),
    englishBatch: { stage1: "05:30 AM - 07:00 AM", stage2: "03:30 PM - 05:00 PM" },
  });
  assert.equal(sa.liveBlockReason(u, "English", "stage1"), null); // both live before
  assert.equal(sa.liveBlockReason(u, "English", "stage2"), null);
  const r = promoteOne(u, "English", "stage1");
  assert.deepEqual(r, { from: "stage1", to: "stage2" });
  assert.equal(u.englishAccess.stage1, false);
  assert.equal(u.englishDone.stage1, true);
  assert.equal(u.englishAccess.stage2, true);
  assert.equal(u.englishBatch.stage2, "03:30 PM - 05:00 PM"); // own timing kept
  assert.equal(u.englishBatch.stage1, "");
});

test("promote refuses a stage the student is not in", () => {
  assert.ok(promoteOne(student(), "English", "stage3").error);
  assert.ok(promoteOne(student(), "Hindi", null).error);
});

test("dropout: no live class, no attendance, but special class also blocked", () => {
  const u = student({ isDropout: true, englishAccess: on(), englishDone: on("stage1", "stage2") });
  assert.match(sa.liveBlockReason(u, "English", "stage2"), /classes are paused/);
  assert.match(sa.liveBlockReason(u, "English", "stage1", { assembly: true }), /classes are paused/);
  assert.equal(sa.hasMaterial(u, "English", "stage1"), true);
  assert.equal(sa.hasMaterial(u, "English", "stage2"), true);
});

test("staff are never blocked; switch can turn the check off", () => {
  assert.equal(sa.liveBlockReason({ role: "teacher" }, "English", "stage5"), null);
  process.env.ENFORCE_STAGE_ACCESS = "false";
  assert.equal(sa.liveBlockReason(student(), "English", "stage5"), null);
  delete process.env.ENFORCE_STAGE_ACCESS;
});

test("tidy: a stage switched ON again is current again (not finished)", () => {
  const u = student({ englishAccess: on("stage1", "stage2"), englishDone: on("stage1") });
  sa.tidy(u);
  assert.equal(u.englishDone.stage1, false);
});

test("promote routes need a login", async () => {
  const { app, io, stopCrons } = require("../index");
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [method, path] of [
      ["GET", "/api/admin/promote/candidates?stage=stage1"],
      ["POST", "/api/admin/promote"],
    ]) {
      const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      assert.equal(r.status, 401, `${method} ${path}`);
    }
  } finally {
    server.close();
    io.close();
    stopCrons();
  }
});
