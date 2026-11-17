// 👥 One phone number can have TWO accounts:
//    • one STUDENT account  (student app)
//    • one STAFF account    (trainer / manager / admin — trainer & manager apps)
// e.g. a trainer who also wants to learn as a student uses the same number in both.
//
// The apps tell the server which one they want with  "app": "student" | "trainer" | "manager".
// Old app versions don't send it → we still pick the right account (see pickLogin).
const STAFF = ["teacher", "manager", "admin"];

const sideOfRole = (role) => (STAFF.includes(role) ? "staff" : "student");

/** "student" | "staff" | "" (unknown — old app) */
const appSide = (req) => {
  const a = String((req.body && req.body.app) || req.get?.("x-app") || "").toLowerCase().trim();
  if (a === "student") return "student";
  if (["trainer", "teacher", "manager", "admin", "staff"].includes(a)) return "staff";
  return "";
};

/** Mongo filter for one side ({} = both sides) */
const sideFilter = (side) => {
  if (side === "staff") return { role: { $in: STAFF } };
  if (side === "student") return { role: { $nin: STAFF } }; // also old accounts without a role
  return {};
};

module.exports = { STAFF, sideOfRole, appSide, sideFilter };
