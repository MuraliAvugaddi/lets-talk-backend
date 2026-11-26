// 🙋 Student → trainer → manager requests
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_that_is_definitely_longer_than_32_chars";
process.env.ENFORCE_STAGE_ACCESS = "true";
const test = require("node:test");
const assert = require("node:assert/strict");

const push = require("../utils/push");
const pushed = [];
push.later = (fn) => fn();
push.toUsers = async (ids, msg) => pushed.push({ ids: [].concat(ids).map(String), title: msg.title });

const on = (...n) => Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((i) => [`stage${i}`, n.includes(i)]));
const people = [
  { _id: "t2a", name: "Mam 2A", role: "teacher", mode: "online", language: "English", teacherStage: "stage2", teacherSection: "A" },
  { _id: "t2b", name: "Mam 2B", role: "teacher", mode: "online", language: "English", teacherStage: "stage2", teacherSection: "B" },
  { _id: "t3a", name: "Mam 3A", role: "teacher", mode: "online", language: "English", teacherStage: "stage3", teacherSection: "A" },
  { _id: "th1", name: "Hindi Sir", role: "teacher", mode: "offline", language: "Hindi", teacherStage: "stage1", teacherSection: "None" },
  { _id: "mOn", name: "Online Manager", role: "manager", mode: "online" },
  { _id: "mOff", name: "Offline Manager", role: "manager", mode: "offline" },
];
const User = require("../Models/users");
const matches = (u, q) =>
  Object.entries(q).every(([k, v]) => {
    if (v && v.$regex) return new RegExp(v.$regex, v.$options).test(u[k] || "");
    if (v && v.$in) return v.$in.includes(u[k]);
    return u[k] === v;
  });
User.find = (q) => ({ select: () => ({ lean: async () => people.filter((u) => matches(u, q)) }) });

const ClassRequest = require("../Models/classRequest");
let db = [];
const wrap = (d) => {
  d.save = async () => d;
  return d;
};
ClassRequest.create = async (d) => {
  const doc = wrap({ _id: `64b00000000000000000000${db.length + 1}`, createdAt: new Date(), ...d, messages: [...d.messages] });
  db.push(doc);
  return doc;
};
ClassRequest.countDocuments = async () => 0;
ClassRequest.findById = (id) => ({
  populate: async () => {
    const d = db.find((x) => x._id === id);
    if (!d) return null;
    d.student = { _id: d.student._id || d.student, phone: "9999900000", name: d.studentName };
    return d;
  },
});

const c = require("../Controllers/UserContollers/classRequestController");
const call = (fn, req) =>
  new Promise((resolve) => {
    const res = { code: 200, status(x) { this.code = x; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    fn({ io: null, params: {}, body: {}, query: {}, ...req }, res);
  });

const student = { _id: "s1", name: "Venkat", role: "student", mode: "online", onlineSection: "A", englishAccess: on(3), englishDone: on(2), hindiAccess: on() };
const trainer = (id) => ({ ...people.find((p) => p._id === id) });

test("goes to MY section's trainer of MY current stage; promoted stage refused", async () => {
  // promoted 2 → 3: Stage 2 is refused
  let r = await call(c.createRequest, { user: student, body: { language: "English", stage: "stage2", type: "absent" } });
  assert.equal(r.code, 403);

  r = await call(c.createRequest, { user: student, body: { language: "English", stage: "stage3", type: "other_batch", preferredBatch: "06:30 PM - 08:00 PM", message: "office work" } });
  assert.equal(r.code, 201);
  assert.deepEqual(r.body.request.trainerNames, ["Mam 3A"]);
  assert.equal(r.body.request.status, "open");
  assert.equal(r.body.request.studentPhone, undefined); // never in trainer / student views
  assert.deepEqual(pushed.at(-1).ids, ["t3a"]);
});

test("trainer accepts → student notified; escalate → manager; manager sees phone and solves", async () => {
  const id = db[0]._id;
  let r = await call(c.accept, { user: trainer("t3a"), params: { id }, body: { text: "OK, join 6:30" } });
  assert.equal(r.body.request.status, "accepted");
  assert.deepEqual(pushed.at(-1).ids, ["s1"]);
  assert.match(pushed.at(-1).title, /accepted/);

  // another trainer can't touch it
  r = await call(c.accept, { user: trainer("t2a"), params: { id } });
  assert.equal(r.code, 404);

  r = await call(c.escalate, { user: trainer("t3a"), params: { id }, body: { text: "Please check" } });
  assert.equal(r.body.request.status, "escalated");
  assert.ok(pushed.some((p) => p.ids.includes("mOn") && /manager/i.test(p.title)));
  assert.equal(r.body.request.studentPhone, undefined); // trainer view: no phone

  r = await call(c.getRequest, { user: { _id: "mOn", role: "manager", name: "Online Manager" }, params: { id } });
  assert.equal(r.body.request.studentPhone, "9999900000"); // 📞 manager sees phone

  r = await call(c.solve, { user: { _id: "mOn", role: "manager", name: "Online Manager" }, params: { id }, body: { text: "Done, joined evening batch" } });
  assert.equal(r.body.request.status, "solved");
  assert.ok(pushed.some((p) => p.ids.includes("s1") && /solved/.test(p.title)));
  assert.ok(pushed.some((p) => p.ids.includes("t3a") && /solved/.test(p.title)));

  r = await call(c.reply, { user: student, params: { id }, body: { text: "thanks" } });
  assert.equal(r.code, 400); // closed
});

test("offline Hindi student → offline Hindi trainer; no trainer → offline manager", async () => {
  const off = { _id: "s2", name: "Ravi", role: "student", mode: "offline", englishAccess: on(5), hindiAccess: on(1) };
  let r = await call(c.createRequest, { user: off, body: { language: "Hindi", stage: "stage1", type: "absent" } });
  assert.deepEqual(r.body.request.trainerNames, ["Hindi Sir"]);
  r = await call(c.createRequest, { user: off, body: { language: "English", stage: "stage5", type: "other", message: "help" } });
  assert.equal(r.body.request.status, "escalated");
  assert.deepEqual(pushed.at(-1).ids, ["mOff"]);
});

test("manager filters: stage, section, batch, IST date range", () => {
  const { extraFilters } = require("../Controllers/UserContollers/classRequestController");
  const q = extraFilters({ stage: "2", section: "Section A", batch: "6:30 PM", from: "2026-11-20", to: "2026-11-26" });
  assert.equal(q.stage, "stage2");
  const re = new RegExp(q.section.$regex, "i");
  assert.ok(re.test("A") && re.test("Section A") && re.test(" section a ") && !re.test("B"));
  assert.deepEqual(q.$and[0].$or, [{ batchTime: "06:30 PM - 08:00 PM" }, { preferredBatch: "06:30 PM - 08:00 PM" }]);
  const [byDay, byCreated] = q.$and[1].$or;
  assert.deepEqual(byDay.forDate, { $gte: "2026-11-20", $lte: "2026-11-26" });
  assert.equal(byCreated.createdAt.$gte.toISOString(), "2026-11-19T18:30:00.000Z");
  assert.equal(byCreated.createdAt.$lte.toISOString(), "2026-11-26T18:29:59.999Z");
  assert.deepEqual(extraFilters({ stage: "x", section: "all", batch: "", from: "bad" }), {});
});

test("class day: past → today, too far → +30 days, bad → today", () => {
  const { _internal } = require("../Controllers/UserContollers/classRequestController");
  const today = _internal.istDay();
  assert.equal(_internal.cleanForDate("2020-01-01"), today);
  assert.equal(_internal.cleanForDate("junk"), today);
  assert.equal(_internal.cleanForDate(""), today);
  const tmr = _internal.istDay(new Date(Date.now() + 86400000));
  assert.equal(_internal.cleanForDate(tmr), tmr);
  assert.equal(_internal.cleanForDate("2999-01-01"), _internal.istDay(new Date(Date.now() + 30 * 86400000)));
});

test("answered requests don't block new ones; 3 waiting do", async () => {
  const s = { _id: "s9", name: "Asha", role: "student", mode: "online", onlineSection: "A", englishAccess: on(2), hindiAccess: on() };
  const old = ClassRequest.countDocuments;
  const body = { language: "English", stage: "stage2", type: "absent" };
  try {
    // 5 sent today, all answered (0 waiting) → still allowed
    ClassRequest.countDocuments = async (q) => (q.status ? 0 : 5);
    let r = await call(c.createRequest, { user: s, body });
    assert.equal(r.code, 201);
    // 3 still waiting → blocked with a clear message
    ClassRequest.countDocuments = async (q) => (q.status ? 3 : 3);
    r = await call(c.createRequest, { user: s, body });
    assert.equal(r.code, 429);
    assert.match(r.body.message, /3 requests waiting/);
  } finally {
    ClassRequest.countDocuments = old;
  }
});