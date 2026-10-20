// =====================================================
// 📲 APP UPDATE ("A new version is available — Update")
//
// Admin sets, per platform:
//   latestBuild   → newest build in the store (pubspec "1.0.1+6" → 6)
//   minimumBuild  → older than this = MUST update (app is blocked until updated)
//   versionName   → "1.0.1" (shown to the student)
//   notes         → "What's new"
//   storeUrl      → Play Store / App Store link
// Student app compares its own build number on every open.
// =====================================================
const AppConfig = require("../../Models/appConfig");

const KEY = "app_version";
const ANDROID_PACKAGE = process.env.ANDROID_PACKAGE || "com.surendra.letsspeak";

const DEFAULTS = {
  android: {
    latestBuild: 0,
    minimumBuild: 0,
    versionName: "",
    notes: "",
    storeUrl: `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`,
  },
  ios: {
    latestBuild: 0,
    minimumBuild: 0,
    versionName: "",
    notes: "",
    storeUrl: process.env.IOS_STORE_URL || "", // https://apps.apple.com/app/id1234567890
  },
};

const int = (v, d = 0) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : d;
};
const str = (v, max) => String(v ?? "").trim().slice(0, max);

const clean = (input, base) => {
  const p = input && typeof input === "object" ? input : {};
  const latestBuild = int(p.latestBuild, base.latestBuild);
  // minimum can never be above latest
  const minimumBuild = Math.min(int(p.minimumBuild, base.minimumBuild), latestBuild);
  const storeUrl = str(p.storeUrl ?? base.storeUrl, 300);
  return {
    latestBuild,
    minimumBuild,
    versionName: str(p.versionName ?? base.versionName, 20),
    notes: str(p.notes ?? base.notes, 500),
    storeUrl: /^https:\/\//i.test(storeUrl) || storeUrl === "" ? storeUrl : base.storeUrl,
  };
};

const load = async () => {
  const doc = await AppConfig.findOne({ key: KEY }).lean();
  const v = (doc && doc.value) || {};
  return {
    android: { ...DEFAULTS.android, ...(v.android || {}) },
    ios: { ...DEFAULTS.ios, ...(v.ios || {}) },
    updatedAt: doc ? doc.updatedAt : null,
    updatedByName: doc ? doc.updatedByName : "",
  };
};

// GET /api/app-version  (public — the app asks before login too)
const getAppVersion = async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.status(200).json(await load());
  } catch (error) {
    console.error("Get App Version Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// PUT /api/admin/app-version  { android: {...}, ios: {...} }   (admin)
const setAppVersion = async (req, res) => {
  try {
    const current = await load();
    const value = {
      android: clean(req.body.android, current.android),
      ios: clean(req.body.ios, current.ios),
    };
    await AppConfig.findOneAndUpdate(
      { key: KEY },
      { $set: { value, updatedByName: req.user ? req.user.name || "" : "" } },
      { upsert: true, returnDocument: "after" }
    );
    // ⚡ open apps check right away
    if (req.io) req.io.emit("app_version_updated", { at: Date.now() });
    res.status(200).json({ success: true, message: "Saved. Students will see the update message.", ...value });
  } catch (error) {
    console.error("Set App Version Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { getAppVersion, setAppVersion, _internal: { clean, DEFAULTS } };