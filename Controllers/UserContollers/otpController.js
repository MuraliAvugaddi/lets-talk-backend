// =====================================================
// 🔐 PHONE OTP (MSG91) — replaces Firebase phone auth
//
//   POST /api/otp/send    { phone, purpose: "signup" | "reset" }
//   POST /api/otp/verify  { phone, purpose, otp }  → { otpToken }
//   then:
//   POST /api/register        { ..., otpToken }          (purpose signup)
//   POST /api/reset-password  { phone, newPassword, otpToken } (purpose reset)
//
// Cost control: 6-digit code, 5 min valid, resend after 60 s, max 5 SMS per
// phone per day, max 5 wrong tries per code, + IP rate limit on the route.
// Apple / Google reviewers: OTP_TEST_NUMBERS=9999999999:123456 (no SMS sent).
// =====================================================
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const OtpCode = require("../../Models/otpCode");
const User = require("../../Models/users");
const { sendOtpSms } = require("../../utils/msg91");
const messageCentral = require("../../utils/messageCentral");

// Which SMS company sends the OTP:
//   OTP_PROVIDER=messagecentral → Message Central (no own DLT needed)
//   OTP_PROVIDER=msg91          → MSG91 with your DLT template
//   (not set)                   → MSG91 if its keys exist, else printed in the terminal (dev)
const provider = () => String(process.env.OTP_PROVIDER || "msg91").toLowerCase();
const { getJwtSecret } = require("../../middleware/authMiddleware");
const { dateKey } = require("../../utils/time");

const OTP_LENGTH = 6;
const EXPIRY_MIN = Number(process.env.OTP_EXPIRY_MIN || 5);
const RESEND_SEC = Number(process.env.OTP_RESEND_SEC || 60);
const MAX_PER_DAY = Number(process.env.OTP_MAX_PER_DAY || 5);
const MAX_ATTEMPTS = 5;
const TOKEN_MIN = 15; // otpToken valid for 15 min (time to finish signup / type new password)
const PURPOSES = ["signup", "reset"];

const cleanPhone = (p) => String(p || "").replace(/\D/g, "").slice(-10);
const phoneCandidates = (p) => {
  const ten = cleanPhone(p);
  return [ten, `91${ten}`, `+91${ten}`, `0${ten}`];
};

// "9999999999:123456,8888888888:111111" → Map
const testNumbers = () =>
  new Map(
    String(process.env.OTP_TEST_NUMBERS || "")
      .split(",")
      .map((x) => x.trim().split(":"))
      .filter(([p, c]) => p && c && /^\d{10}$/.test(cleanPhone(p)) && /^\d{4,8}$/.test(c))
      .map(([p, c]) => [cleanPhone(p), c])
  );

const hash = (phone, purpose, otp) =>
  crypto.createHmac("sha256", getJwtSecret()).update(`${phone}|${purpose}|${otp}`).digest("hex");

const randomOtp = () => String(crypto.randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------- token handed to register / reset ----------
const signOtpToken = (phone, purpose) =>
  jwt.sign({ typ: "otp", phone, purpose }, getJwtSecret(), { expiresIn: `${TOKEN_MIN}m` });

/** Returns the verified 10-digit phone, or throws */
const verifyOtpToken = (token, purpose) => {
  if (!token || typeof token !== "string") throw new Error("missing");
  const d = jwt.verify(token, getJwtSecret());
  if (d.typ !== "otp" || d.purpose !== purpose || !/^\d{10}$/.test(d.phone || "")) throw new Error("invalid");
  return d.phone;
};

// =====================================================
// POST /api/otp/send
// =====================================================
const sendOtp = async (req, res) => {
  try {
    const phone = cleanPhone(req.body.phone);
    const purpose = String(req.body.purpose || "").toLowerCase();
    if (phone.length !== 10 || !/^[6-9]/.test(phone)) {
      return res.status(400).json({ message: "Enter a valid 10-digit mobile number." });
    }
    if (!PURPOSES.includes(purpose)) return res.status(400).json({ message: "Invalid request." });

    const exists = await User.exists({ phone: { $in: phoneCandidates(phone) } });
    if (purpose === "signup" && exists) {
      return res.status(409).json({ message: "This number is already registered. Please log in." });
    }
    if (purpose === "reset" && !exists) {
      return res.status(404).json({ message: "No account found with this number." });
    }

    const now = new Date();
    const today = dateKey(now);
    let rec = await OtpCode.findOne({ phone, purpose });

    if (rec) {
      const wait = Math.ceil((new Date(rec.lastSentAt).getTime() + RESEND_SEC * 1000 - now.getTime()) / 1000);
      if (wait > 0) {
        return res.status(429).json({ message: `Please wait ${wait} s before asking for a new code.`, resendIn: wait });
      }
      if (rec.day === today && rec.sentToday >= MAX_PER_DAY) {
        return res.status(429).json({ message: "Too many codes today. Please try again tomorrow or contact the institute." });
      }
    }

    // 🍎 store reviewers / test phones: fixed code, no SMS
    const test = testNumbers().get(phone);
    let otp = test || randomOtp();
    let providerRef = "";

    if (!test) {
      if (provider() === "messagecentral" && !module.exports._send) {
        // Message Central creates + checks the code itself
        const sent = await messageCentral.sendOtp(phone, OTP_LENGTH);
        if (!sent.ok) return res.status(502).json({ message: "Could not send the SMS. Please try again in a minute." });
        providerRef = sent.ref;
        otp = "";
      } else {
        const sent = await (module.exports._send || sendOtpSms)(phone, otp, EXPIRY_MIN);
        if (!sent.ok) return res.status(502).json({ message: "Could not send the SMS. Please try again in a minute." });
      }
    }

    const sameDay = rec && rec.day === today;
    await OtpCode.updateOne(
      { phone, purpose },
      {
        $set: {
          codeHash: otp ? hash(phone, purpose, otp) : "",
          providerRef,
          expiresAt: new Date(now.getTime() + EXPIRY_MIN * 60000),
          attempts: 0,
          lastSentAt: now,
          day: today,
          sentToday: sameDay ? rec.sentToday + 1 : 1,
          verifiedAt: null,
        },
      },
      { upsert: true }
    );

    res.status(200).json({
      success: true,
      message: `Code sent to +91 ${phone.slice(0, 2)}******${phone.slice(-2)}`,
      expiresIn: EXPIRY_MIN * 60,
      resendIn: RESEND_SEC,
      length: OTP_LENGTH,
    });
  } catch (error) {
    console.error("Send OTP Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// POST /api/otp/verify
// =====================================================
const verifyOtp = async (req, res) => {
  try {
    const phone = cleanPhone(req.body.phone);
    const purpose = String(req.body.purpose || "").toLowerCase();
    const otp = String(req.body.otp || "").replace(/\D/g, "");
    if (phone.length !== 10 || !PURPOSES.includes(purpose) || otp.length < 4) {
      return res.status(400).json({ message: "Enter the code you received." });
    }

    const rec = await OtpCode.findOne({ phone, purpose });
    if (!rec || rec.verifiedAt) {
      return res.status(400).json({ message: "Please request a new code." });
    }
    if (new Date(rec.expiresAt).getTime() < Date.now()) {
      return res.status(400).json({ message: "This code has expired. Tap Resend to get a new one.", expired: true });
    }
    if (rec.attempts >= MAX_ATTEMPTS) {
      return res.status(429).json({ message: "Too many wrong tries. Tap Resend to get a new code." });
    }

    let correct;
    if (rec.providerRef) {
      const r = await messageCentral.verifyOtp(rec.providerRef, otp);
      if (r === "expired") {
        return res.status(400).json({ message: "This code has expired. Tap Resend to get a new one.", expired: true });
      }
      if (r === "error") {
        return res.status(502).json({ message: "Could not check the code right now. Please try again." });
      }
      correct = r === "ok";
    } else {
      correct = !!rec.codeHash && safeEqual(rec.codeHash, hash(phone, purpose, otp));
    }

    if (!correct) {
      rec.attempts += 1;
      await rec.save();
      const left = MAX_ATTEMPTS - rec.attempts;
      return res.status(400).json({
        message: left > 0 ? `Wrong code. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong tries. Tap Resend.",
        attemptsLeft: left,
      });
    }

    rec.verifiedAt = new Date(); // a code works only once
    await rec.save();
    res.status(200).json({ success: true, otpToken: signOtpToken(phone, purpose), expiresIn: TOKEN_MIN * 60 });
  } catch (error) {
    console.error("Verify OTP Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = {
  sendOtp,
  verifyOtp,
  verifyOtpToken,
  _internal: { hash, randomOtp, testNumbers, signOtpToken, cleanPhone },
};
