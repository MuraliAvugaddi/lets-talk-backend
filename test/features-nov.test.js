// Temporary online/offline change, trainer test drafts — logic + route protection
process.env.TZ = "Asia/Kolkata";
process.env.JWT_SECRET = "test_secret_that_is_definitely_longer_than_32_chars";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/never-used";
process.env.ENFORCE_AUTH = "false";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
mongoose.set("bufferCommands", false);

const { untilFor } = require("../Controllers/UserContollers/modeChangeController")._internal;
const { checkQuestions } = require("../Controllers/UserContollers/testController");
const { dateKey } = require("../utils/time");

// 10:00 AM IST on 6 Nov 2026 = 04:30 UTC
const morning = new Date("2026-11-06T04:30:00Z");
// 9:00 PM IST on 6 Nov 2026 = 15:30 UTC
const night = new Date("2026-11-06T15:30:00Z");

test("1 day set in the morning ends tonight (IST)", () => {
  const u = untilFor("1d", morning);
  assert.equal(dateKey(u), "06-11-2026");
  assert.equal(u.toISOString(), "2026-11-06T18:29:59.999Z");
});

test("1 day set after 7 PM is for tomorrow's class", () => {
  assert.equal(dateKey(untilFor("1d", night)), "07-11-2026");
});

test("2 days and 1 week", () => {
  assert.equal(dateKey(untilFor("2d", morning)), "07-11-2026");
  assert.equal(dateKey(untilFor("1w", morning)), "12-11-2026");
  assert.equal(untilFor("permanent", morning), null);
});

test("trainer drafts: empty options refused (strict), admin publish stays lenient", () => {
  const q = [{ questionText: "Hi?", options: ["a", ""], correctOptionIndex: 0 }];
  assert.match(checkQuestions(q, { strict: true }), /Question 1/);
  assert.equal(checkQuestions(q), null);
  assert.match(checkQuestions([]), /at least one/);
  assert.match(
    checkQuestions([{ questionText: "x", options: ["a", "b"], correctOptionIndex: 2 }]),
    /Question 1/
  );
});

test("new admin / trainer routes need a login", async () => {
  const { app, io, stopCrons } = require("../index");
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [method, path] of [
      ["POST", "/api/admin/change-mode"],
      ["POST", "/api/admin/change-mode/end"],
      ["GET", "/api/admin/mode-changes"],
      ["POST", "/api/test/trainer/test-draft"],
      ["GET", "/api/test/trainer/test-drafts"],
      ["GET", "/api/test/admin/test-drafts"],
      ["POST", "/api/test/admin/test-draft/review"],
    ]) {
      const res = await fetch(base + path, { method, headers: { Connection: "close", "Content-Type": "application/json" } });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  } finally {
    stopCrons();
    io.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(() => r()));
    await mongoose.disconnect().catch(() => {});
  }
});
