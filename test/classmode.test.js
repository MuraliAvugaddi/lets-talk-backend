// Run: npm test   (no database, no Stream account needed)
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_that_is_definitely_longer_than_32_chars";
process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:1/never-used";
process.env.STREAM_API_KEY = "k";
process.env.STREAM_API_SECRET = "s";

const test = require("node:test");
const assert = require("node:assert/strict");

// ---- fake Stream (patched before the controller loads) ----
const created = [];
const sdk = require("@stream-io/node-sdk");
sdk.StreamClient = class {
  async upsertUsers() {}
  get video() {
    return {
      call: (type, id) => ({
        getOrCreate: async () => {
          created.push(id);
          return { call: { custom: {} } };
        },
        get: async () => {
          if (!created.includes(id)) {
            const e = new Error("not found");
            e.metadata = { responseCode: 404 };
            throw e;
          }
          return { call: { custom: {} } };
        },
        update: async () => ({}),
        goLive: async () => ({}),
        updateCallMembers: async () => ({}),
      }),
    };
  }
};

// ---- fake class-mode switches ----
const cm = require("../utils/classMode");
let modes = { rain: null, assembly: null };
cm.getModes = async () => modes;

const { prepareCall } = require("../Controllers/UserContollers/streamController");

const run = async (user, body) => {
  const out = {};
  const res = { status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } };
  await prepareCall({ user, body }, res);
  return out;
};

const offlineTrainer = { _id: "t1", name: "Ravi", role: "teacher", mode: "offline" };
const offlineStudent = { _id: "s1", name: "Rocky", role: "student", mode: "offline" };
const onlineStudent = { _id: "s2", name: "Asha", role: "student", mode: "online" };
const onlineTrainer = { _id: "t2", name: "Mam", role: "teacher", mode: "online" };
const admin = { _id: "a1", name: "Principal", role: "admin", mode: "online" };

test("rain day: offline trainer + students meet in one online class per stage", async () => {
  modes = { rain: { active: true }, assembly: null };
  const t = await run(offlineTrainer, { language: "English", stage: "stage2", section: "none", type: "class" });
  assert.equal(t.code, 200);
  assert.match(t.body.callId, /^offline_english_stage2_class_/);
  assert.equal(t.body.rain, true);

  const s = await run(offlineStudent, { language: "English", stage: "stage2", section: "a", type: "class" });
  assert.equal(s.body.callId, t.body.callId); // same room as their trainer
  assert.equal(s.body.started, true);

  // online students are not affected
  const o = await run(onlineStudent, { language: "English", stage: "stage2", section: "a", type: "class" });
  assert.match(o.body.callId, /^english_stage2_seca_class_/);

  // removed → offline users are back to normal (no offline call id)
  modes = { rain: null, assembly: null };
  const back = await run(offlineTrainer, { language: "English", stage: "stage2", section: "none", type: "class" });
  assert.doesNotMatch(back.body.callId, /^offline_/);
});

test("principal class: admin hosts one call, everyone joins it, normal classes paused", async () => {
  modes = { rain: null, assembly: { active: true, sessionKey: "k9", startTime: "11:00 AM", title: "Principal" } };

  // before the admin starts it → not started
  const early = await run(onlineStudent, { type: "assembly" });
  assert.equal(early.body.started, false);

  const host = await run(admin, { type: "assembly" });
  assert.equal(host.code, 200);
  assert.match(host.body.callId, /^assembly_k9_/);
  assert.equal(host.body.host, true);

  for (const u of [onlineStudent, offlineStudent, onlineTrainer, offlineTrainer]) {
    const r = await run(u, { type: "assembly", language: "Hindi", stage: "stage5" });
    assert.equal(r.body.callId, host.body.callId, u.name);
    assert.equal(r.body.started, true);
    assert.equal(r.body.host, undefined);
  }

  // a trainer pressing the normal "Start live class" is told to join the principal class
  const blocked = await run(onlineTrainer, { language: "English", stage: "stage1", section: "a", type: "class" });
  assert.equal(blocked.code, 409);
  assert.match(blocked.body.error, /Normal classes are paused/);

  // a student opening a normal class sees "not started"
  const st = await run(onlineStudent, { language: "English", stage: "stage1", section: "a", type: "class" });
  assert.equal(st.body.started, false);
  assert.equal(st.body.assemblyActive, true);

  // removed → no principal class
  modes = { rain: null, assembly: null };
  const none = await run(onlineStudent, { type: "assembly" });
  assert.equal(none.body.assembly, false);
});

test("2,500 students: Stream user + member calls are batched (100 per call)", async () => {
  const { ensureUser, addMember } = require("../utils/streamBatch");
  let upsertCalls = 0;
  let memberCalls = 0;
  const client = { upsertUsers: async (list) => { upsertCalls += 1; assert.ok(list.length <= 100); } };
  const call = { updateCallMembers: async ({ update_members }) => { memberCalls += 1; assert.ok(update_members.length <= 100); } };
  const jobs = [];
  for (let i = 0; i < 2500; i++) {
    jobs.push(ensureUser(client, { id: `u${i}`, name: `S${i}`, role: "user" }));
    jobs.push(addMember(call, "assembly_x_20261018_v3", `u${i}`));
  }
  await Promise.all(jobs);
  assert.equal(upsertCalls, 25);
  assert.equal(memberCalls, 25);
  // already known → no new Stream call
  await ensureUser(client, { id: "u1", name: "S1", role: "user" });
  await addMember(call, "assembly_x_20261018_v3", "u1");
  assert.equal(upsertCalls, 25);
  assert.equal(memberCalls, 25);
});

test("special class: waiting students are answered from memory, not Stream", async () => {
  modes = { rain: null, assembly: { active: true, sessionKey: "zz", startTime: "11:00 AM", title: "Surendra Sir Special Class" } };
  const before = created.length;
  const a = await run({ _id: "w1", name: "W1", role: "student", mode: "online" }, { type: "assembly" });
  const b = await run({ _id: "w2", name: "W2", role: "student", mode: "online" }, { type: "assembly" });
  assert.equal(a.body.started, false);
  assert.equal(b.body.started, false);
  const host = await run(admin, { type: "assembly" });
  assert.equal(host.body.host, true);
  assert.equal(created.length, before + 1);
  const c = await run({ _id: "w3", name: "W3", role: "student", mode: "offline" }, { type: "assembly" });
  assert.equal(c.body.started, true);
  assert.equal(c.body.title, "Surendra Sir Special Class");
});

// ---- 📋 special class attendance report ----
test("assembly report: present/absent split by trainers and students, with every stage", () => {
  const { _report } = require("../Controllers/UserContollers/classModeController");
  const users = [
    { _id: "s1", name: "Asha", role: "student", mode: "online", englishAccess: { stage1: true }, hindiAccess: { stage2: true } },
    { _id: "s2", name: "Bala", role: "student", mode: "offline", englishAccess: { stage3: true } },
    { _id: "t1", name: "Trainer Ravi", role: "teacher", mode: "offline", language: "Hindi", teacherStage: "stage2" },
  ];
  const records = [
    { userId: "s1", status: "Partial", arrivalStatus: "Present", totalMinutesSpent: 20, firstJoinAt: new Date(), joinTime: new Date() },
    { userId: "s1", status: "Late", totalMinutesSpent: 25 },
    { userId: "t1", status: "Absent", arrivalStatus: "Late", totalMinutesSpent: 0 },
  ];
  const { people, summary } = _report.buildAssemblyReport(users, records);
  assert.deepEqual(summary.students, { total: 2, present: 1, absent: 1 });
  assert.deepEqual(summary.trainers, { total: 1, present: 1, absent: 0 });
  const asha = people.find((p) => p.id === "s1");
  assert.equal(asha.present, true);
  assert.equal(asha.status, "Late"); // best of her records
  assert.equal(asha.minutes, 25);
  assert.equal(asha.inClass, true);
  assert.deepEqual(asha.classes.map((c) => `${c.language}-${c.stage}`), ["English-stage1", "Hindi-stage2"]);
  const bala = people.find((p) => p.id === "s2");
  assert.equal(bala.present, false);
  assert.equal(bala.mode, "offline");
  const ravi = people.find((p) => p.id === "t1");
  assert.equal(ravi.role, "trainer");
  assert.equal(ravi.status, "Late");
  assert.deepEqual(ravi.classes, [{ language: "Hindi", stage: "stage2" }]);
  assert.equal(people[people.length - 1].id, "s2"); // absent listed last
});

// 🔀 SECTION MERGE — B merged into A: B students join A's call, B's trainer is told
test("section merge: guest students join the host class, guest trainer is told, unmerge sends them back", async () => {
  modes = { rain: null, assembly: null };
  const SectionMerge = require("../Models/sectionMerge");
  const original = SectionMerge.findOne;
  let active = { _id: "m1", language: "English", stage: "stage1", hostSection: "A", guestSection: "B", isActive: true };
  SectionMerge.findOne = (q) => ({
    lean: async () => (active && q.guestSection === active.guestSection && q.stage === active.stage ? active : null),
  });
  try {
    const trainerA = { _id: "tA", name: "A sir", role: "teacher", mode: "online", onlineSection: "", teacherSection: "A" };
    const trainerB = { _id: "tB", name: "B mam", role: "teacher", mode: "online", onlineSection: "", teacherSection: "B" };
    const studentB = { _id: "sB", name: "Bala", role: "student", mode: "online", onlineSection: "B" };

    const host = await run(trainerA, { language: "English", stage: "stage1", section: "a", type: "class" });
    assert.equal(host.code, 200);
    assert.match(host.body.callId, /^english_stage1_seca_class_/);

    // student of B — even if an old app sends "b" — lands in A's class
    const s = await run(studentB, { language: "English", stage: "stage1", section: "b", type: "class" });
    assert.equal(s.body.callId, host.body.callId);
    assert.equal(s.body.mergedInto, "A");
    assert.equal(s.body.ownSection, "B");

    // B's trainer can't open an empty B class while merged
    const tb = await run(trainerB, { language: "English", stage: "stage1", section: "b", type: "class" });
    assert.equal(tb.code, 409);
    assert.equal(tb.body.mergedInto, "A");

    // other stages are not affected
    const other = await run(studentB, { language: "English", stage: "stage2", section: "b", type: "class" });
    assert.match(other.body.callId, /^english_stage2_secb_class_/);

    // unmerged → back to B
    active = null;
    const back = await run(studentB, { language: "English", stage: "stage1", section: "b", type: "class" });
    assert.match(back.body.callId, /^english_stage1_secb_class_/);
    assert.equal(back.body.mergedInto, null);
  } finally {
    SectionMerge.findOne = original;
  }
});
