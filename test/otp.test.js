// Run: npm test — MSG91 OTP flow with fake database + fake SMS
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_that_is_definitely_longer_than_32_chars";
process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:1/never-used";
process.env.OTP_TEST_NUMBERS = "9999999999:123456";

const test = require("node:test");
const assert = require("node:assert/strict");

// ---- fake models ----
const OtpCode = require("../Models/otpCode");
const User = require("../Models/users");
const store = new Map();
const key = (q) => `${q.phone}|${q.purpose}`;
OtpCode.findOne = async (q) => {
  const r = store.get(key(q));
  return r ? { ...r, save: async function () { store.set(key(q), { ...this }); } } : null;
};
OtpCode.updateOne = async (q, u) => {
  store.set(key(q), { ...(store.get(key(q)) || q), ...u.$set });
};
let registered = new Set();
User.exists = async (q) => q.phone.$in.some((p) => registered.has(p));

const otp = require("../Controllers/UserContollers/otpController");
const sms = [];
otp._send = async (phone, code) => {
  sms.push({ phone, code });
  return { ok: true };
};

const call = async (fn, body) => {
  const out = {};
  const res = { status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } };
  await fn({ body }, res);
  return out;
};

test("OTP: send → wrong code → right code → token; resend wait; single use", async () => {
  const s = await call(otp.sendOtp, { phone: "98765 43210", purpose: "signup" });
  assert.equal(s.code, 200);
  assert.equal(sms.length, 1);
  const code = sms[0].code;
  assert.match(code, /^\d{6}$/);

  // resend too soon
  const again = await call(otp.sendOtp, { phone: "9876543210", purpose: "signup" });
  assert.equal(again.code, 429);

  const bad = await call(otp.verifyOtp, { phone: "9876543210", purpose: "signup", otp: code === "000000" ? "111111" : "000000" });
  assert.equal(bad.code, 400);
  assert.equal(bad.body.attemptsLeft, 4);

  const ok = await call(otp.verifyOtp, { phone: "9876543210", purpose: "signup", otp: code });
  assert.equal(ok.code, 200);
  assert.equal(otp.verifyOtpToken(ok.body.otpToken, "signup"), "9876543210");
  assert.throws(() => otp.verifyOtpToken(ok.body.otpToken, "reset")); // wrong purpose

  const reuse = await call(otp.verifyOtp, { phone: "9876543210", purpose: "signup", otp: code });
  assert.equal(reuse.code, 400); // a code works once
});

test("OTP: signup for a registered number / reset for unknown number are refused", async () => {
  registered = new Set(["9123456789"]);
  assert.equal((await call(otp.sendOtp, { phone: "9123456789", purpose: "signup" })).code, 409);
  assert.equal((await call(otp.sendOtp, { phone: "9000000001", purpose: "reset" })).code, 404);
  assert.equal((await call(otp.sendOtp, { phone: "1234", purpose: "signup" })).code, 400);
});

test("OTP: reviewer test number gets the fixed code and no SMS", async () => {
  registered = new Set();
  const before = sms.length;
  const s = await call(otp.sendOtp, { phone: "9999999999", purpose: "signup" });
  assert.equal(s.code, 200);
  assert.equal(sms.length, before);
  const ok = await call(otp.verifyOtp, { phone: "9999999999", purpose: "signup", otp: "123456" });
  assert.equal(ok.code, 200);
});
