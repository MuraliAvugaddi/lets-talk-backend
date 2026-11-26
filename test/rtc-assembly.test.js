// 🎙 Special class: only Sir runs it; a trainer can't re-open it after "End"
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_that_is_definitely_longer_than_32_chars";
const test = require("node:test");
const assert = require("node:assert/strict");

const lk = require("../utils/livekit");
let live = true;
const closed = [];
lk.provider = () => "livekit";
lk.isConfigured = () => true;
lk.isRoomLive = async () => live;
lk.joinToken = async () => "tok";
lk.closeRoom = async (r) => closed.push(r);
require("./../Controllers/UserContollers/streamController").forgetAssembly = () => {};

const rtc = require("../Controllers/UserContollers/rtcController");
const call = (fn, req) =>
  new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); return this; } };
    fn({ io: null, body: {}, ...req }, res);
  });

const room = "assembly_all_20261126_v1";
const trainer = { _id: "t1", name: "Mam", role: "teacher" };
const admin = { _id: "a1", name: "Sir", role: "admin" };

test("trainer joins while live; after End the trainer gets 'ended' (no new empty room)", async () => {
  live = true;
  let r = await call(rtc.roomToken, { user: trainer, body: { room } });
  assert.equal(r.code, 200);
  live = false; // Sir ended it
  r = await call(rtc.roomToken, { user: trainer, body: { room } });
  assert.equal(r.code, 409);
  assert.equal(r.body.ended, true);
  // Sir can always open it
  r = await call(rtc.roomToken, { user: admin, body: { room } });
  assert.equal(r.code, 200);
});

test("only Sir (admin / manager) can end / mute in the special class; trainers still run normal classes", async () => {
  let r = await call(rtc.end, { user: trainer, body: { room } });
  assert.equal(r.code, 403);
  assert.equal(closed.length, 0);
  r = await call(rtc.end, { user: { ...admin, role: "manager" }, body: { room } });
  assert.equal(r.code, 200);
  assert.deepEqual(closed, [room]);
  r = await call(rtc.end, { user: trainer, body: { room: "english_stage2_seca_20261126_v1" } });
  assert.equal(r.code, 200);
});
