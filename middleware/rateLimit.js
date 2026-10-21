// =====================================================
// RATE LIMITS — stop password guessing and signup spam.
// Normal app traffic is never limited.
// =====================================================

const { rateLimit } = require("express-rate-limit");

const make = (windowMinutes, limit, message) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { message },
  });

module.exports = {
  // 30 login attempts per 15 min per IP (a whole classroom on one Wi-Fi still fits)
  loginLimiter: make(15, 30, "Too many login attempts. Please wait 15 minutes."),
  resetLimiter: make(60, 10, "Too many password reset attempts. Please wait an hour."),
  registerLimiter: make(60, 20, "Too many sign-ups from this network. Please try later."),
  // 📩 OTP SMS cost guard: 10 codes per 15 min per IP (per-phone limits are inside the controller)
  otpLimiter: make(15, 10, "Too many OTP requests. Please wait 15 minutes."),
  otpVerifyLimiter: make(15, 30, "Too many attempts. Please wait 15 minutes."),
};
