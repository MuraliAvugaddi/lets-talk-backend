// 📨 Stage messages: only the right students see them / get the notification
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_that_is_definitely_longer_than_32_chars";
const test = require("node:test");
const assert = require("node:assert/strict");

const push = require("../utils/push");
const pushed = [];
push.later = (fn) => fn();
push.toUsers = async (ids, msg) => pushed.push({ ids, msg });

const StageMessage = require("../Models/stageMessage");
const User = require("../Models/users");
let db = [];
StageMessage.create = async (d) => {
  const doc = { _id: `m${db.length + 1}`, createdAt: new Date(), ...d };
  db.unshift(doc);
  return doc;
};
const pick = (q = {}) =>
  db.filter((x) => (q.student === null ? !x.student : q.student ? String(x.student) === String(q.student) : true));
StageMessage.find = (q) => ({ sort: () => ({ limit: () => ({ lean: async () => pick(q).map((x) => ({ ...x })) }) }) });
StageMessage.deleteMany = async (q) => {
  db = db.filter((x) => !(x.kind === q.kind && !x.student && new Date(x.createdAt) >= q.createdAt.$gte));
};
StageMessage.findByIdAndDelete = (id) => ({
  lean: async () => {
    const d = db.find((x) => x._id === id);
    db = db.filter((x) => x._id !== id);
    return d || null;
  },
});
let lastFilter = null;
User.find = (q) => {
  lastFilter = q;
  return { select: () => ({ lean: async () => [{ _id: "u1" }, { _id: "u2" }] }) };
};

const ctrl = require("../Controllers/UserContollers/stageMessageController");
const call = (fn, req) =>
  new Promise((resolve) => {
    const res = {
      code: 200,
      set() { return this; },
      status(c) { this.code = c; return this; },
      json(b) { resolve({ code: this.code, body: b }); return this; },
    };
    fn({ io: { emit() {} }, params: {}, body: {}, ...req }, res);
  });

const on = (...n) => Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((i) => [`stage${i}`, n.includes(i)]));
const stu = (eng, hin, mode = "online") => ({ role: "student", mode, englishAccess: on(...eng), hindiAccess: on(...hin) });
const admin = { _id: "a1", role: "admin", name: "Admin" };

test("English Stage 2 online → only English stage-2 online students", async () => {
  const r = await call(ctrl.sendMessage, { user: admin, body: { message: "Class at 7", language: "English", stages: ["2"], mode: "online" } });
  assert.equal(r.code, 201);
  assert.equal(r.body.data.group, "English • Stage 2 • Online");
  assert.deepEqual(lastFilter.$or, [{ "englishAccess.stage2": true }]);
  assert.deepEqual(lastFilter.mode, { $ne: "offline" });
  assert.equal(pushed.at(-1).ids.length, 2);

  const see = async (u) => (await call(ctrl.listMessages, { user: u })).body.messages.length;
  assert.equal(await see(stu([2], [])), 1); // ✅ English stage 2 online
  assert.equal(await see(stu([2], [], "offline")), 0); // offline → no
  assert.equal(await see(stu([1], [])), 0); // stage 1 → no
  assert.equal(await see(stu([], [2])), 0); // Hindi stage 2 → no
  assert.equal(await see(admin), 1); // admin sees all
});

test("All stages, both languages, offline", async () => {
  db = [];
  const r = await call(ctrl.sendMessage, { user: admin, body: { message: "Holiday", language: "All", stages: [], mode: "offline" } });
  assert.equal(r.body.data.group, "English & Hindi • All stages • Offline");
  assert.equal(lastFilter.$or, undefined); // everyone (also new students without a stage)
  assert.equal(lastFilter.mode, "offline");
  const see = async (u) => (await call(ctrl.listMessages, { user: u })).body.messages.length;
  assert.equal(await see(stu([5], [], "offline")), 1);
  assert.equal(await see(stu([], [3], "offline")), 1);
  assert.equal(await see(stu([], [], "offline")), 1); // new student, no stage yet
  assert.equal(await see(stu([5], [], "online")), 0);
});

test("checks + delete", async () => {
  assert.equal((await call(ctrl.sendMessage, { user: admin, body: { message: " ", language: "English" } })).code, 400);
  assert.equal((await call(ctrl.sendMessage, { user: admin, body: { message: "x", language: "French" } })).code, 400);
  const id = db[0]._id;
  assert.equal((await call(ctrl.deleteMessage, { user: admin, params: { id } })).code, 200);
  assert.equal((await call(ctrl.deleteMessage, { user: admin, params: { id } })).code, 404);
});

test("notifications from the institute show on the Messages page (group + personal)", async () => {
  db = [];
  const mongoose = require("mongoose");
  const rs = Object.getOwnPropertyDescriptor(mongoose.connection, "readyState");
  Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true });
  try {
    await ctrl.record({ kind: "notice", title: "📢 Notice", message: "No class on Sunday", language: "All", mode: "online" });
    await ctrl.record({ kind: "fee", title: "✅ Fee received", message: "Thanks", student: "s77" });
    // special class saved 3 times today → only the newest stays
    for (const t of ["10 AM", "11 AM", "12 PM"]) await ctrl.record({ kind: "special", title: "🎙 Special", message: `Today at ${t}` });
  } finally {
    if (rs) Object.defineProperty(mongoose.connection, "readyState", rs);
    else delete mongoose.connection.readyState;
  }
  const list = async (u) => (await call(ctrl.listMessages, { user: u })).body.messages;
  const me = { ...stu([2], [], "online"), _id: "s77" };
  const other = { ...stu([2], [], "online"), _id: "s88" };
  const mine = await list(me);
  assert.deepEqual(mine.map((m) => m.kind).sort(), ["fee", "notice", "special"]);
  assert.equal(mine.find((m) => m.kind === "special").message, "Today at 12 PM");
  assert.equal(mine.find((m) => m.kind === "fee").group, "Just for you");
  assert.deepEqual((await list(other)).map((m) => m.kind).sort(), ["notice", "special"]); // fee is only for s77
  assert.deepEqual((await list({ ...stu([2], [], "offline"), _id: "s99" })).map((m) => m.kind), ["special"]); // online-only notice
});
