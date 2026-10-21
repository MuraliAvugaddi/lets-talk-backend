// =====================================================
// 📩 MSG91 — sends the OTP SMS (India, DLT-approved template)
//
// .env (Render → Environment):
//   MSG91_AUTH_KEY=...            (MSG91 → Settings → Authkey)
//   MSG91_OTP_TEMPLATE_ID=...     (MSG91 → OTP → template, must contain ##OTP##)
//
// Without MSG91_AUTH_KEY (your laptop) the OTP is printed in the terminal instead,
// so you can test signup without spending SMS.
// =====================================================
const AUTH_KEY = () => process.env.MSG91_AUTH_KEY || "";
const TEMPLATE_ID = () => process.env.MSG91_OTP_TEMPLATE_ID || "";

const isConfigured = () => !!(AUTH_KEY() && TEMPLATE_ID());

/**
 * Send our own OTP through MSG91's OTP API (we generate + verify it ourselves).
 * @returns {Promise<{ok: boolean, error?: string, dev?: boolean}>}
 */
const sendOtpSms = async (phone10, otp, expiryMinutes = 5) => {
  if (!isConfigured()) {
    if (process.env.NODE_ENV === "production") {
      return { ok: false, error: "SMS service is not set up (MSG91_AUTH_KEY / MSG91_OTP_TEMPLATE_ID missing)." };
    }
    console.log(`📩 [DEV — no MSG91 key] OTP for ${phone10}: ${otp}`);
    return { ok: true, dev: true };
  }

  const url =
    "https://control.msg91.com/api/v5/otp" +
    `?template_id=${encodeURIComponent(TEMPLATE_ID())}` +
    `&mobile=91${phone10}` +
    `&otp=${otp}` +
    `&otp_length=${String(otp).length}` +
    `&otp_expiry=${expiryMinutes}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(url, {
      method: "POST",
      headers: { authkey: AUTH_KEY(), "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.type === "success") return { ok: true };
    console.error("MSG91 send failed:", res.status, JSON.stringify(data));
    return { ok: false, error: data.message || `SMS failed (${res.status})` };
  } catch (e) {
    console.error("MSG91 error:", e.message);
    return { ok: false, error: "Could not reach the SMS service" };
  }
};

module.exports = { sendOtpSms, isConfigured };
