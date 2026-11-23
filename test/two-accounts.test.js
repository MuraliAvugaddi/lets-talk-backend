// 👥 one phone number: a trainer account AND a student account
process.env.JWT_SECRET = "test_secret_that_is_definitely_longer_than_32_chars";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/never-used";
process.env.ENFORCE_AUTH = "false";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
mongoose.set("bufferCommands", false);

const User = require("../Models/users");
const { app, io, stopCrons } = require("../index");
const { sideFilter } = require("../utils/accountSide");

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
const call = (path, body) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(body) });

// ---- tiny fake "users" collection --------------------------------------
const STAFF = ["teacher", "manager", "admin"];
const matches = (u, q) => {
  if (q.phone && q.phone.$in && !q.phone.$in.includes(u.phone)) return false;
  if (q.role && q.role.$in && !q.role.$in.includes(u.role)) return false;
  if (q.role && q.role.$nin && q.role.$nin.includes(u.role)) return false;
  return true;
};
let db = [];
const doc = (u) => ({ ...u, save: async function () { Object.assign(db.find((x) => x._id === this._id), { password: this.password }); } });
const lean = (v) => ({ select: () => ({ lean: async () => v }), lean: async () => v, then: (r, j) => Promise.resolve(v).then(r, j) });
User.find = (q) => lean(db.filter((u) => matches(u, q)).map(doc));
User.findOne = (q) => lean(db.find((u) => matches(u, q)) || null);
User.exists = async (q) => (db.find((u) => matches(u, q)) ? { _id: 1 } : null);
User.create = async (d) => {
  const u = { _id: String(db.length + 1), ...d };
  db.push(u);
  return u;
};

test.beforeEach(async () => {
  db = [{ _id: "t1", name: "Ramesh", phone: "9876543210", role: "teacher", password: await bcrypt.hash("trainer1", 4) }];
});

test("trainer's number: student sign-up OTP is allowed", async () => {
  assert.equal(await User.exists({ phone: { $in: ["9876543210"] }, ...sideFilter("student") }), null);
});

test("trainer's number: student account can be created", async () => {
  const r = await call("/api/register", { name: "Ramesh", phone: "9876543210", password: "student1", app: "student" });
  assert.equal(r.status, 201, await r.text());
  assert.equal(db.length, 2);
  assert.equal(db[1].role, "student");
});

test("second student account on the same number is refused", async () => {
  await call("/api/register", { name: "Ramesh", phone: "9876543210", password: "student1" });
  const r = await call("/api/register", { name: "Ramesh", phone: "9876543210", password: "student2" });
  assert.equal(r.status, 400);
});

test("each app logs into its own account (same password too)", async () => {
  db.push({ _id: "s1", name: "Ramesh", phone: "9876543210", role: "student", password: await bcrypt.hash("trainer1", 4) });
  const s = await (await call("/api/login", { phone: "9876543210", password: "trainer1", app: "student" })).json();
  const t = await (await call("/api/login", { phone: "9876543210", password: "trainer1", app: "trainer" })).json();
  const old = await (await call("/api/login", { phone: "9876543210", password: "trainer1" })).json();
  assert.equal(s.role, "student");
  assert.equal(t.role, "teacher");
  assert.equal(old.role, "teacher"); // old app without "app" → trainer, like before
});

test("different passwords pick the right account even in old apps", async () => {
  db.push({ _id: "s1", name: "Ramesh", phone: "9876543210", role: "student", password: await bcrypt.hash("student1", 4) });
  const old = await (await call("/api/login", { phone: "9876543210", password: "student1" })).json();
  assert.equal(old.role, "student");
  const bad = await call("/api/login", { phone: "9876543210", password: "nope123" });
  assert.equal(bad.status, 401);
});

test("trainer without a student account gets a clear message in the student app", async () => {
  const r = await call("/api/login", { phone: "9876543210", password: "trainer1", app: "student" });
  assert.equal(r.status, 403);
  assert.match((await r.json()).message, /Trainer app/);
});

test("student account cannot log in to the trainer app", async () => {
  db.push({ _id: "s9", name: "Sita", phone: "9000000009", role: "student", password: await bcrypt.hash("student9", 4) });
  const r = await call("/api/login", { phone: "9000000009", password: "student9", app: "trainer" });
  assert.equal(r.status, 403);
});
