// 🎧 LiveKit audio classes: tokens, who may join which room, 2,000 students = 1 server request
process.env.JWT_SECRET = "test_secret_that_is_definitely_longer_than_32_chars";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/never-used";
process.env.LIVEKIT_URL = "wss://audio.example.com";
process.env.LIVEKIT_API_KEY = "APItestkey";
process.env.LIVEKIT_API_SECRET = "testsecret_testsecret_testsecret_1234";
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const lk = require("../utils/livekit");
const { dateKey } = require("../utils/time");

const today = dateKey().split("-").reverse().join("");

test("join token: audio only, right room, trainer = admin", async () => {
  const t = await lk.joinToken({ userId: "u1", name: "Ravi", room: `english_stage1_seca_class_${today}_v3`, staff: false });
  const d = jwt.verify(t, process.env.LIVEKIT_API_SECRET);
  assert.equal(d.sub, "u1");
  assert.equal(d.name, "Ravi");
  assert.equal(d.video.room, `english_stage1_seca_class_${today}_v3`);
  assert.deepEqual(d.video.canPublishSources, ["microphone"]);
  assert.ok(!d.video.roomAdmin);
  assert.equal(JSON.parse(d.metadata).role, "user");
  const t2 = await lk.joinToken({ userId: "t1", name: "Trainer", room: "x_room", staff: true });
  const d2 = jwt.verify(t2, process.env.LIVEKIT_API_SECRET);
  assert.equal(d2.video.roomAdmin, true);
  assert.equal(JSON.parse(d2.metadata).role, "admin");
});

test("2,000 students asking 'is the class live?' → 1 LiveKit request", async () => {
  let calls = 0;
  lk._internal.setClient({
    listRooms: async (names) => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return [{ name: names[0] }];
    },
  });
  const room = `hindi_stage2_class_${today}_v3`;
  const r = await Promise.all(Array.from({ length: 2000 }, () => lk.isRoomLive(room)));
  assert.equal(calls, 1);
  assert.ok(r.every(Boolean));
});

test("trainer start → students see 'live' at once (no waiting for cache)", async () => {
  const room = `english_stage3_secb_class_${today}_v3`;
  lk._internal.setClient({ listRooms: async () => [], createRoom: async () => ({}), updateRoomMetadata: async () => ({}) });
  assert.equal(await lk.isRoomLive(room), false);
  await lk.openRoom(room);
  assert.equal(await lk.isRoomLive(room), true);
});

test("students may only join their own (or merged) section's room", async () => {
  const { _internal } = require("../Controllers/UserContollers/rtcController");
  const student = { role: "student", mode: "online", onlineSection: "A" };
  assert.equal(await _internal.mayJoin(student, `english_stage1_seca_class_${today}_v3`), true);
  assert.equal(await _internal.mayJoin(student, `hindi_stage1_class_${today}_v3`), true);
  assert.equal(await _internal.mayJoin(student, "english_stage1_seca_class_20200101_v3"), false); // old day
  assert.equal(await _internal.mayJoin({ role: "teacher" }, "anything_room"), true);
  assert.equal(await _internal.mayJoin(student, `offline_english_stage1_class_${today}_v3`), false);
  assert.equal(await _internal.mayJoin({ ...student, mode: "offline" }, `offline_english_stage1_class_${today}_v3`), true);
});
