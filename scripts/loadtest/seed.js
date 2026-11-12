// =====================================================================
// 🧪 LOAD TEST — step 1: create test accounts in a SEPARATE database
//
//   MONGO_URI=mongodb://.../lets_talk_loadtest  JWT_SECRET=...  node scripts/loadtest/seed.js 2000
//
// ⚠️ The database name MUST contain "loadtest" — this script refuses to touch
//    the real lets_talk database. Students: phones 7000000000…, password "Test@1234".
// Writes scripts/loadtest/accounts.json (ids + login tokens) for run.js.
// =====================================================================
process.env.TZ = "Asia/Kolkata";
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../../Models/users");
const { signToken } = require("../../middleware/authMiddleware");

const N = Number(process.argv[2] || 2000);
const SECTIONS = ["A", "B", "C", "D", "E"];
const STAGES = ["stage1", "stage2", "stage3"];

(async () => {
  const uri = process.env.MONGO_URI || "";
  if (!/loadtest/i.test(uri)) {
    console.error("❌ MONGO_URI must point to a database with 'loadtest' in its name (never the real one).");
    process.exit(1);
  }
  await mongoose.connect(uri);
  await User.syncIndexes();
  await mongoose.connection.db.dropDatabase(); // fresh start every run
  await User.syncIndexes();

  const hash = await bcrypt.hash("Test@1234", 10); // same password for all → seeding stays fast
  const access = (stage) => Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [`stage${n}`, `stage${n}` === stage]));

  // students: 90% English online (5 sections × 3 stages), 10% Hindi online
  const students = [];
  for (let i = 0; i < N; i++) {
    const hindi = i % 10 === 9;
    const stage = STAGES[i % STAGES.length];
    students.push({
      name: `LT Student ${i + 1}`,
      phone: String(7000000000 + i),
      password: hash,
      mode: "online",
      role: "student",
      language: hindi ? "Hindi" : "English",
      onlineSection: hindi ? "None" : SECTIONS[Math.floor(i / STAGES.length) % SECTIONS.length],
      englishAccess: access(hindi ? "-" : stage),
      hindiAccess: access(hindi ? stage : "-"),
      feeStatus: i % 3 === 0 ? "paid" : "unpaid",
    });
  }
  // one trainer per class room + 1 admin
  const staff = [];
  let p = 6000000000;
  for (const stage of STAGES) {
    for (const sec of SECTIONS) {
      staff.push({ name: `LT Trainer ${stage} ${sec}`, phone: String(p++), password: hash, mode: "online", role: "teacher", language: "English", teacherStage: stage, teacherSection: sec });
    }
    staff.push({ name: `LT Trainer Hindi ${stage}`, phone: String(p++), password: hash, mode: "online", role: "teacher", language: "Hindi", teacherStage: stage, teacherSection: "None" });
  }
  staff.push({ name: "LT Admin", phone: String(p++), password: hash, mode: "online", role: "admin" });

  const t0 = Date.now();
  const docs = await User.insertMany([...students, ...staff], { ordered: false });
  const out = docs.map((u) => ({
    id: String(u._id),
    role: u.role,
    language: u.language,
    stage: u.role === "student" ? STAGES.find((s) => (u.language === "Hindi" ? u.hindiAccess : u.englishAccess)[s]) : u.teacherStage,
    section: u.role === "student" ? u.onlineSection : u.teacherSection,
    token: signToken(u),
  }));
  fs.writeFileSync(process.env.ACCOUNTS_FILE || path.join(__dirname, "accounts.json"), JSON.stringify(out));
  console.log(`✅ Created ${students.length} students + ${staff.length} staff in ${Date.now() - t0} ms → scripts/loadtest/accounts.json`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
