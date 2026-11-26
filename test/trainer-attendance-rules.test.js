// 👔 Managers / admins have no attendance; trainer lists + auto-absent are trainers only
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_that_is_definitely_longer_than_32_chars";
const test = require("node:test");
const assert = require("node:assert/strict");

const User = require("../Models/users");
const Attendance = require("../Models/attendance");
const queries = [];
User.findById = () => ({ lean: async () => ({ _id: "507f1f77bcf86cd799439011", role: "manager", name: "Mgr", mode: "online" }) });
let created = 0;
Attendance.create = async () => {
  created++;
  return {};
};
User.find = (q) => {
  queries.push(q);
  return { select: () => ({ lean: async () => [] }) };
};
Attendance.find = () => ({ lean: async () => [] });

const c = require("../Controllers/UserContollers/attendanceController");
const call = (fn, req) =>
  new Promise((resolve) => {
    const res = { code: 200, set() { return this; }, status(x) { this.code = x; return this; }, json(b) { resolve({ code: this.code, body: b }); return this; } };
    fn({ io: null, query: {}, params: {}, ...req }, res);
  });

test("a manager joining a class gets NO attendance record", async () => {
  const user = { _id: "507f1f77bcf86cd799439011", role: "manager" };
  const r = await call(c.joinOnlineClass, { user, body: { language: "English", stage: "stage1" } });
  assert.equal(r.code, 200);
  assert.equal(r.body.noAttendance, true);
  assert.equal(created, 0);
});

test("trainer attendance list asks for trainers only (no managers / admins)", async () => {
  queries.length = 0;
  await call(c.getTrainerAttendance, { user: { _id: "a", role: "admin" }, query: { date: "26-11-2026" } });
  assert.ok(queries.length >= 1);
  assert.equal(queries[0].role, "teacher");
});
