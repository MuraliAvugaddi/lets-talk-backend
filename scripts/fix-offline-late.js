// One-time repair: offline check-ins that were judged against the WRONG class.
// (Old apps sent the class running when the screen opened, e.g. the 9:00 class
// for a 10:30 student who checked in at 10:25 → "78 min late".)
//
// Check first (changes nothing):   node scripts/fix-offline-late.js --days 7
// Then save the fixes:             node scripts/fix-offline-late.js --days 7 --apply
process.env.TZ = "Asia/Kolkata";
require("dotenv").config();
const mongoose = require("mongoose");
const Attendance = require("../Models/attendance");
const User = require("../Models/users");
const rules = require("../utils/attendanceRules");
const { istMinutesOfDay } = require("../utils/time");
const { offlineBatchFor } = require("../Controllers/UserContollers/attendanceController");

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : def;
};
const DAYS = Number(arg("--days", 7));
const APPLY = process.argv.includes("--apply");

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
  const records = await Attendance.find({
    markedAt: { $gte: since },
    userMode: "offline",
    status: { $in: ["Present", "Late"] },
  }).lean();

  const users = new Map(
    (await User.find({ _id: { $in: [...new Set(records.map((r) => String(r.userId)))] } }).lean()).map((u) => [
      String(u._id),
      u,
    ])
  );

  let changed = 0;
  for (const r of records) {
    const user = users.get(String(r.userId));
    if (!user || user.role !== "student") continue;
    const when = new Date(r.markedAt);
    const batch = offlineBatchFor(user, when, r.batchTime, r.language, r.stage);
    const a = rules.studentArrival(istMinutesOfDay(when), batch);
    if (batch === r.batchTime && a.status === r.status && (a.lateByMinutes || 0) === (r.lateByMinutes || 0)) continue;

    changed++;
    console.log(
      `${r.date}  ${user.name.padEnd(28)} ${String(r.batchTime).padEnd(20)} ${r.status} ${r.lateByMinutes || 0}m  →  ${batch}  ${a.status} ${a.lateByMinutes}m`
    );
    if (APPLY) {
      await Attendance.updateOne(
        { _id: r._id },
        { $set: { batchTime: batch, status: a.status, arrivalStatus: a.status, lateByMinutes: a.lateByMinutes } }
      );
    }
  }
  console.log(`\n${records.length} offline check-ins checked, ${changed} ${APPLY ? "fixed ✅" : "would be fixed (add --apply to save)"}`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
