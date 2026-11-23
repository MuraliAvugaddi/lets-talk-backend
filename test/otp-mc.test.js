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

test("Message Central: US number (starts 2-5) is sent with country code 1", async () => {
  let got = null;
  mc.sendOtp = async (phone, len, cc) => { got = { phone, cc }; return { ok: true, ref: "VID-US" }; };
  const s = await call(otp.sendOtp, { phone: "+1 (202) 555-0123", purpose: "signup" });
  assert.equal(s.code, 200);
  assert.deepEqual(got, { phone: "2025550123", cc: "1" });
  await call(otp.sendOtp, { phone: "9876512345", purpose: "signup" });
  assert.equal(got.cc, "91");
});

test("Message Central: all countries — mapped numbers sent with their code, unknown refused", async () => {
  process.env.OTP_COUNTRY_MAP = "0501234567=971,7400123456=44,6581234567=65-81234567";
  const sent = [];
  mc.sendOtp = async (phone, len, cc) => { sent.push(`+${cc} ${phone}`); return { ok: true, ref: "VID-X" + sent.length }; };
  for (const p of ["0501234567", "07400 123456", "65 8123 4567", "4155550100", "9876500001"]) {
    const r = await call(otp.sendOtp, { phone: p, purpose: "signup" });
    assert.equal(r.code, 200, p);
  }
  assert.deepEqual(sent, ["+971 501234567", "+44 7400123456", "+65 81234567", "+1 4155550100", "+91 9876500001"]);
  const refused = await call(otp.sendOtp, { phone: "0509999999", purpose: "signup" });
  assert.equal(refused.code, 400);
  assert.match(refused.body.message, /contact the institute/);
  assert.equal(sent.length, 5); // no SMS for the unknown number
  delete process.env.OTP_COUNTRY_MAP;
});
