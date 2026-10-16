// =====================================================
// FIREBASE ADMIN — verifies the phone-OTP login done in the app.
// verifyIdToken only needs the project id (it checks Google's public keys),
// so no service-account file is required.
// =====================================================

const { initializeApp, getApps } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const getFirebaseAuth = () => {
  if (!getApps().length) {
    initializeApp({
      projectId: process.env.FIREBASE_PROJECT_ID || "let-s-speak-cbc27",
    });
  }
  return getAuth();
};

// Returns the verified phone number in E.164 (e.g. "+919876543210"), or throws
const verifyPhoneIdToken = async (idToken) => {
  if (!idToken || typeof idToken !== "string") {
    throw new Error("Missing OTP verification token");
  }
  const decoded = await getFirebaseAuth().verifyIdToken(idToken);
  if (!decoded.phone_number) {
    throw new Error("OTP token has no verified phone number");
  }
  return decoded.phone_number;
};

// Compare the last 10 digits so "+91 98765 43210" and "9876543210" match
const samePhone = (a, b) => {
  const last10 = (v) => String(v || "").replace(/\D/g, "").slice(-10);
  return last10(a).length === 10 && last10(a) === last10(b);
};

module.exports = { verifyPhoneIdToken, samePhone };
