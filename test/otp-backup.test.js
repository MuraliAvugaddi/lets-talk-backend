// 🅱️ Plan B: institute backup code works for SIGN-UP even when an SMS was sent, never for reset
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_that_is_definitely_longer_than_32_chars";
process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:1/never-used";
process.env.OTP_PROVIDER = "messagecentral";
process.env.OTP_SIGNUP_FALLBACK_CODE = "939831";

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
let exists = false;
User.exists = async () => exists;

const mc = require("../utils/messageCentral");
let mcChecked = 0;
mc.sendOtp = async () => ({ ok: true, ref: "VID-B" });
mc.verifyOtp = async (ref, code) => { mcChecked++; return code === "111222" ? "ok" : "wrong"; };

const otp = require("../Controllers/UserContollers/otpController");
const call = async (fn, body) => {
  const out = {};
  const res = { status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } };
  await fn({ body }, res);
  return out;
};

test("sign-up: SMS sent but not received → backup code 939831 works (US number)", async () => {
  const s = await call(otp.sendOtp, { phone: "4155550100", purpose: "signup" });
  assert.equal(s.code, 200);
  const v = await call(otp.verifyOtp, { phone: "4155550100", purpose: "signup", otp: "939831" });
  assert.equal(v.code, 200);
  assert.ok(v.body.otpToken);
  assert.equal(mcChecked, 0); // Message Central not even asked
});

test("sign-up: the real SMS code still works", async () => {
  await call(otp.sendOtp, { phone: "9876500011", purpose: "signup" });
  const v = await call(otp.verifyOtp, { phone: "9876500011", purpose: "signup", otp: "111222" });
  assert.equal(v.code, 200);
});

test("password reset: backup code does NOT work (protects accounts)", async () => {
  exists = true;
  await call(otp.sendOtp, { phone: "9876500022", purpose: "reset" });
  const v = await call(otp.verifyOtp, { phone: "9876500022", purpose: "reset", otp: "939831" });
  assert.equal(v.code, 400);
  exists = false;
});

test("wrong backup code counts as a wrong try", async () => {
  await call(otp.sendOtp, { phone: "9876500033", purpose: "signup" });
  const v = await call(otp.verifyOtp, { phone: "9876500033", purpose: "signup", otp: "939830" });
  assert.equal(v.code, 400);
  assert.equal(v.body.attemptsLeft, 4);
});

test("no backup code set → plan B is off", async () => {
  delete process.env.OTP_SIGNUP_FALLBACK_CODE;
  await call(otp.sendOtp, { phone: "9876500044", purpose: "signup" });
  const v = await call(otp.verifyOtp, { phone: "9876500044", purpose: "signup", otp: "939831" });
  assert.equal(v.code, 400);
});

test("🌍 Plan B works for every country: US auto, UK/UAE/any unknown number (no SMS sent)", async () => {
  process.env.OTP_SIGNUP_FALLBACK_CODE = "939831";
  let sms = 0;
  mc.sendOtp = async () => { sms++; return { ok: true, ref: "VID-W" }; };
  const numbers = {
    "🇺🇸 USA": "4155550199",
    "🇬🇧 UK (07400 123456)": "07400123456",
    "🇦🇪 UAE (050 123 4567)": "0501234567",
    "🇦🇺 Australia": "0412345678",
    "🇩🇪 Germany (01511 234567)": "01511234567",
  };
  for (const [name, phone] of Object.entries(numbers)) {
    const s = await call(otp.sendOtp, { phone, purpose: "signup" });
    assert.equal(s.code, 200, name);
    const v = await call(otp.verifyOtp, { phone, purpose: "signup", otp: "939831" });
    assert.equal(v.code, 200, name);
    assert.ok(v.body.otpToken, name);
  }
  // US → real SMS; UK 7400… looks Indian (+91) so an SMS is tried there unless it is in OTP_COUNTRY_MAP;
  // UAE / Australia / Germany (start 0/1) → no SMS at all. Plan B worked for all of them.
  assert.equal(sms, 2);
});

test("unknown country without backup code → clear 'contact institute' message", async () => {
  delete process.env.OTP_SIGNUP_FALLBACK_CODE;
  const s = await call(otp.sendOtp, { phone: "0509999998", purpose: "signup" });
  assert.equal(s.code, 400);
  assert.match(s.body.message, /contact the institute/);
});

test("unknown country + password reset → refused even with backup code set", async () => {
  process.env.OTP_SIGNUP_FALLBACK_CODE = "939831";
  exists = true;
  const s = await call(otp.sendOtp, { phone: "0509999997", purpose: "reset" });
  assert.equal(s.code, 400);
  exists = false;
});
