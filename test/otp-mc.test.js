// Message Central mode: they hold the code, we keep the verificationId
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_that_is_definitely_longer_than_32_chars";
process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:1/never-used";
process.env.OTP_PROVIDER = "messagecentral";

const test = require("node:test");
const assert = require("node:assert/strict");

const OtpCode = require("../Models/otpCode");
const User = require("../Models/users");
const store = new Map();
const key = (q) => `${q.phone}|${q.purpose}`;
OtpCode.findOne = async (q) => {
  const r = store.get(key(q));
  return r ? { ...r, save: async function () { store.set(key(q), { ...this }); } } : null;
};
OtpCode.updateOne = async (q, u) => store.set(key(q), { ...(store.get(key(q)) || q), ...u.$set });
User.exists = async () => false;

const mc = require("../utils/messageCentral");
mc.sendOtp = async () => ({ ok: true, ref: "VID-1" });
mc.verifyOtp = async (ref, code) => (ref === "VID-1" && code === "482913" ? "ok" : "wrong");

const otp = require("../Controllers/UserContollers/otpController");
const call = async (fn, body) => {
  const out = {};
  const res = { status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } };
  await fn({ body }, res);
  return out;
};

test("Message Central: send stores verificationId, verify asks them", async () => {
  const s = await call(otp.sendOtp, { phone: "9876501234", purpose: "signup" });
  assert.equal(s.code, 200);
  assert.equal(store.get("9876501234|signup").providerRef, "VID-1");
  assert.equal(store.get("9876501234|signup").codeHash, "");

  const bad = await call(otp.verifyOtp, { phone: "9876501234", purpose: "signup", otp: "111111" });
  assert.equal(bad.code, 400);
  const ok = await call(otp.verifyOtp, { phone: "9876501234", purpose: "signup", otp: "482913" });
  assert.equal(ok.code, 200);
  assert.ok(ok.body.otpToken);
});
