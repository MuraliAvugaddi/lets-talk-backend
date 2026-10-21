// =====================================================
// 📩 MESSAGE CENTRAL (VerifyNow) — OTP SMS without your own DLT registration
//   They create the code, send the SMS and check it. We keep the verificationId.
//
// .env (Render → Environment):
//   OTP_PROVIDER=messagecentral
//   MC_CUSTOMER_ID=C-XXXXXXXXXXXX        (Message Central dashboard)
//   MC_PASSWORD=your Message Central login password   (we Base64 it)
// =====================================================
const BASE = "https://cpaas.messagecentral.com";

let token = null;
let tokenAt = 0;
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // re-login every 6 h (or at once on 401)

const isConfigured = () => !!(process.env.MC_CUSTOMER_ID && process.env.MC_PASSWORD);

const call = async (url, opts = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
};

const getToken = async (force = false) => {
  if (!force && token && Date.now() - tokenAt < TOKEN_TTL_MS) return token;
  const key = Buffer.from(String(process.env.MC_PASSWORD || "")).toString("base64");
  const url =
    `${BASE}/auth/v1/authentication/token?customerId=${encodeURIComponent(process.env.MC_CUSTOMER_ID || "")}` +
    `&key=${encodeURIComponent(key)}&scope=NEW&country=91`;
  const { status, data } = await call(url, { headers: { accept: "*/*" } });
  if (status !== 200 || !data.token) {
    console.error("Message Central login failed:", status, JSON.stringify(data));
    throw new Error("Message Central login failed");
  }
  token = data.token;
  tokenAt = Date.now();
  return token;
};

/** Sends an OTP. Returns { ok, ref (verificationId), error } */
const sendOtp = async (phone10, length = 6) => {
  const send = async (force) => {
    const t = await getToken(force);
    const url =
      `${BASE}/verification/v3/send?countryCode=91&customerId=${encodeURIComponent(process.env.MC_CUSTOMER_ID)}` +
      `&flowType=SMS&mobileNumber=${phone10}&otpLength=${length}`;
    return call(url, { method: "POST", headers: { authToken: t } });
  };
  try {
    let r = await send(false);
    if (r.status === 401) r = await send(true); // token expired → log in again once
    const d = r.data || {};
    const ref = d.data && d.data.verificationId;
    if (r.status === 200 && ref) return { ok: true, ref: String(ref) };
    console.error("Message Central send failed:", r.status, JSON.stringify(d));
    return { ok: false, error: (d.data && d.data.errorMessage) || d.message || `SMS failed (${r.status})` };
  } catch (e) {
    console.error("Message Central error:", e.message);
    return { ok: false, error: "Could not reach the SMS service" };
  }
};

/** Checks the code. Returns "ok" | "wrong" | "expired" | "error" */
const verifyOtp = async (ref, code) => {
  const check = async (force) => {
    const t = await getToken(force);
    const url = `${BASE}/verification/v3/validateOtp?verificationId=${encodeURIComponent(ref)}&code=${encodeURIComponent(code)}`;
    return call(url, { headers: { authToken: t } });
  };
  try {
    let r = await check(false);
    if (r.status === 401) r = await check(true);
    const d = r.data || {};
    const inner = d.data || {};
    const rc = Number(inner.responseCode || d.responseCode);
    if (inner.verificationStatus === "VERIFICATION_COMPLETED" || (r.status === 200 && rc === 200)) return "ok";
    if (rc === 702 || rc === 700) return "wrong";
    if (rc === 705 || rc === 703) return "expired";
    console.error("Message Central verify:", r.status, JSON.stringify(d));
    return r.status === 400 ? "wrong" : "error";
  } catch (e) {
    console.error("Message Central verify error:", e.message);
    return "error";
  }
};

module.exports = { isConfigured, sendOtp, verifyOtp };
