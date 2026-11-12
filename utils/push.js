// =====================================================
// 🔔 PUSH NOTIFICATIONS (Firebase Cloud Messaging)
//
// Server setup (once):
//   Firebase console → Project settings → Service accounts → "Generate new private key"
//   On the server:  base64 -w0 key.json   → copy the long line into api.env:
//     FIREBASE_SERVICE_ACCOUNT_BASE64=eyJ0eXBlIjoic2VydmljZV9hY2NvdW50Ii...
//   (no key → push is simply off, nothing else breaks)
//
// Topics (one message reaches thousands of phones in one request):
//   students       → every student
//   mode_online    → online students
//   mode_offline   → offline students
// Single students get their own message (attendance, fee, stage unlock).
// =====================================================
const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");

const APP_NAME = "push";
let messaging = null;

const client = () => {
  if (messaging) return messaging;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || "";
  if (!b64) return null; // no Firebase key → push is simply off (no message)
  try {
    const creds = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    const app = getApps().find((a) => a.name === APP_NAME) || initializeApp({ credential: cert(creds) }, APP_NAME);
    messaging = getMessaging(app);
    console.log("🔔 Push notifications ON");
    return messaging;
  } catch (e) {
    console.error("❌ Push setup failed (check FIREBASE_SERVICE_ACCOUNT_BASE64):", e.message);
    return null;
  }
};

const isEnabled = () => !!client();

// Same look on every phone: Android channel "letsspeak_alerts" (created by the app), sound on
const build = ({ title, body, data = {} }) => ({
  notification: { title: String(title).slice(0, 120), body: String(body).slice(0, 400) },
  data: Object.fromEntries(Object.entries({ ...data, click: data.click || "home" }).map(([k, v]) => [k, String(v)])),
  android: { priority: "high", notification: { channelId: "letsspeak_alerts", sound: "default" } },
  apns: { payload: { aps: { sound: "default" } } },
});

const TOPICS = ["students", "mode_online", "mode_offline"];
const topicForMode = (mode) => (String(mode).toLowerCase() === "offline" ? "mode_offline" : "mode_online");
const topicForTarget = (target) => {
  const t = String(target || "all").toLowerCase();
  if (t === "online") return "mode_online";
  if (t === "offline") return "mode_offline";
  return "students";
};

/** Send to a topic (students / mode_online / mode_offline). Never throws. */
const toTopic = async (topic, msg) => {
  const m = client();
  if (!m || !topic) return;
  try {
    await m.send({ ...build(msg), topic });
  } catch (e) {
    console.error(`Push to topic ${topic} failed:`, e.message);
  }
};

const BAD_TOKEN = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

/** Send to one or more students (by user id or user doc). Never throws. */
const toUsers = async (users, msg) => {
  const m = client();
  if (!m) return;
  try {
    const User = require("../Models/users");
    const list = (Array.isArray(users) ? users : [users]).filter(Boolean);
    const ids = list.map((u) => (u && u._id ? u._id : u));
    const docs = await User.find({ _id: { $in: ids } }).select("fcmTokens").lean();
    const tokens = [...new Set(docs.flatMap((d) => d.fcmTokens || []))];
    for (let i = 0; i < tokens.length; i += 500) {
      const chunk = tokens.slice(i, i + 500);
      const res = await m.sendEachForMulticast({ ...build(msg), tokens: chunk });
      const dead = chunk.filter((_, k) => !res.responses[k].success && BAD_TOKEN.has(res.responses[k].error?.code));
      if (dead.length) await User.updateMany({ fcmTokens: { $in: dead } }, { $pull: { fcmTokens: { $in: dead } } });
    }
  } catch (e) {
    console.error("Push to users failed:", e.message);
  }
};

/** Put the student's phones in the right topics (call after login / mode change). Never throws. */
const syncTopics = async (user) => {
  const m = client();
  if (!m || !user || user.role !== "student") return;
  const tokens = user.fcmTokens || [];
  if (!tokens.length) return;
  const want = new Set(["students", topicForMode(user.mode)]);
  try {
    for (const t of TOPICS) {
      if (want.has(t)) await m.subscribeToTopic(tokens, t);
      else await m.unsubscribeFromTopic(tokens, t);
    }
  } catch (e) {
    console.error("Push topic sync failed:", e.message);
  }
};

/** Phone stopped using this token (logout) → leave all topics. Never throws. */
const dropToken = async (token) => {
  const m = client();
  if (!m || !token) return;
  try {
    for (const t of TOPICS) await m.unsubscribeFromTopic([token], t);
  } catch (_) {}
};

// Never let a notification slow down or break an API answer
const later = (fn) => setImmediate(() => Promise.resolve().then(fn).catch(() => {}));

module.exports = { isEnabled, toTopic, toUsers, syncTopics, dropToken, topicForTarget, topicForMode, later };