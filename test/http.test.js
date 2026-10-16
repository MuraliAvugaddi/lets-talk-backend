// HTTP-level security checks that fail BEFORE any database access.
process.env.JWT_SECRET = "test_secret_that_is_definitely_longer_than_32_chars";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/never-used";
process.env.ENFORCE_AUTH = "false";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

mongoose.set("bufferCommands", false); // DB calls fail fast instead of hanging

const { app, io, stopCrons } = require("../index");
let base;
let server;

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

// Clean shutdown (no process.exit — that crashes libuv on Windows:
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)").
test.after(async () => {
  stopCrons();
  io.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(() => r()));
  await mongoose.disconnect().catch(() => {});
});

const call = (method, path, body, token) =>
  fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Connection: "close", // no keep-alive sockets left open after the tests
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

test("cannot register as admin without an admin token", async () => {
  const res = await call("POST", "/api/register", { name: "x", phone: "9999999999", password: "secret1", role: "admin" });
  assert.equal(res.status, 403);
});

test("password reset is refused without Firebase OTP token", async () => {
  const res = await call("POST", "/api/reset-password", { phone: "9999999999", newPassword: "hacked1" });
  assert.equal(res.status, 401);
});

test("admin-only writes need a token even in transition mode", async () => {
  for (const [method, path] of [
    ["PUT", "/api/update-access"],
    ["PUT", "/api/admin/update-student-status"],
    ["POST", "/api/fee/verify-fee"],
    ["POST", "/api/test/admin/update-test"],
    ["DELETE", "/api/test/admin/delete-test"],
    ["POST", "/api/live/admin/update"],
    ["POST", "/api/admin/merge-sections"],
    ["POST", "/api/admin/auto-absent"],
    ["DELETE", "/api/users/507f1f77bcf86cd799439011"],
  ]) {
    const res = await call(method, path, {});
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test("forged / wrong-secret tokens are rejected", async () => {
  const fake = jwt.sign({ id: "507f1f77bcf86cd799439011" }, "fallback_secret");
  const res = await call("PUT", "/api/update-access", {}, fake);
  assert.equal(res.status, 401);
});

test("geofence blocks check-in from far away (before DB lookup)", async () => {
  const res = await call("POST", "/api/user/mark-attendance", {
    userId: "507f1f77bcf86cd799439011",
    lat: 17.0,
    lng: 83.0,
  });
  assert.equal(res.status, 403);
});

test("batch list is public and has 7 timings", async () => {
  const res = await call("GET", "/api/batches");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.batches.length, 7);
});

test("changing batch timing needs a login token", async () => {
  const res = await call("PUT", "/api/user/batch-time", { batchTime: "batch1" });
  assert.equal(res.status, 401);
});

test("attendance report needs a login token", async () => {
  const res = await call("GET", "/api/attendance-report?userId=507f1f77bcf86cd799439011");
  assert.equal(res.status, 401);
});

test("leaderboard needs a login token", async () => {
  const res = await call("GET", "/api/leaderboard?role=teacher&period=month");
  assert.equal(res.status, 401);
});

test("unknown route → 404 JSON", async () => {
  const res = await call("GET", "/api/nope");
  assert.equal(res.status, 404);
});

test("practice marking needs a staff login token", async () => {
  const r1 = await call("POST", "/api/practice/mark", { studentId: "64b000000000000000000001", language: "English", stage: "stage1" });
  assert.equal(r1.status, 401);
  const r2 = await call("GET", "/api/practice/list?language=English&stage=stage1");
  assert.equal(r2.status, 401);
});
