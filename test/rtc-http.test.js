// Switching to LiveKit: old Stream apps are told to update; new routes need a login
process.env.JWT_SECRET = "test_secret_that_is_definitely_longer_than_32_chars";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/never-used";
process.env.ENFORCE_AUTH = "false";
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
mongoose.set("bufferCommands", false);
const { app, io, stopCrons } = require("../index");
let base, server;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  stopCrons();
  io.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(() => r()));
  await mongoose.disconnect().catch(() => {});
});
const post = (path, body) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(body || {}) });

test("LIVE_PROVIDER=livekit → old app (Stream) gets 'please update'", async () => {
  process.env.LIVE_PROVIDER = "livekit";
  const r = await post("/api/stream/prepare-call", { userId: "507f1f77bcf86cd799439011" });
  assert.equal(r.status, 426);
  assert.equal((await r.json()).update, true);
  delete process.env.LIVE_PROVIDER;
});

test("new LiveKit routes need a login token", async () => {
  for (const p of ["/api/rtc/prepare-call", "/api/rtc/room-token", "/api/rtc/room/end"]) {
    const r = await post(p, { room: "x_room" });
    assert.equal(r.status, 401, p);
  }
});
