// =====================================================
// RATE LIMITS — stop password guessing and signup spam.
// Normal app traffic is never limited.
// =====================================================

const { rateLimit } = require("express-rate-limit");

const make = (windowMinutes, limit, message, extra = {}) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    ...extra,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { message },
  });

// ⚠️ Limits are per IP address. Many students share ONE IP: the institute Wi-Fi,
// and mobile networks (Jio / Airtel put thousands of phones behind one IP).
// So the limits are generous; per-phone limits (OTP, wrong password) live in the controllers.
module.exports = {
  // only FAILED logins count → 100 students logging in on the institute Wi-Fi is fine
  loginLimiter: make(15, 60, "Too many wrong login attempts. Please wait 15 minutes.", { skipSuccessfulRequests: true }),
  resetLimiter: make(60, 30, "Too many password reset attempts. Please wait an hour."),
  // admission day: a whole hall signing up on one Wi-Fi
  registerLimiter: make(60, 100, "Too many sign-ups from this network. Please try later."),
  // 📩 OTP SMS cost guard per IP (each phone number is also limited: 60 s wait, 5 per day)
  otpLimiter: make(15, 40, "Too many OTP requests. Please wait 15 minutes."),
  otpVerifyLimiter: make(15, 80, "Too many attempts. Please wait 15 minutes."),
};
