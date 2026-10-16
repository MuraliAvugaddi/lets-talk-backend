// Run: npm test   (no database needed)
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_that_is_definitely_longer_than_32_chars";
process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:1/never-used";

const test = require("node:test");
const assert = require("node:assert/strict");

const time = require("../utils/time");
const norm = require("../utils/normalize");
const { _internal } = require("../Controllers/UserContollers/attendanceController");

// Build a Date from an IST wall-clock time, independent of the machine's TZ
const ist = (y, m, d, hh, mm) => new Date(Date.UTC(y, m - 1, d, hh, mm) - 330 * 60000);

test("dateKey uses India date, not UTC date", () => {
  // 05:10 IST on 15 Oct = 23:40 UTC on 14 Oct
  assert.equal(time.dateKey(ist(2026, 10, 15, 5, 10)), "15-10-2026");
  assert.equal(time.istMinutesOfDay(ist(2026, 10, 15, 5, 31)), 5 * 60 + 31);
});

test("normalizeDateKey accepts every format the apps send", () => {
  assert.equal(time.normalizeDateKey("5-1-2026"), "05-01-2026");
  assert.equal(time.normalizeDateKey("05-01-2026"), "05-01-2026");
  assert.equal(time.normalizeDateKey("2026-01-05"), "05-01-2026");
  assert.equal(time.normalizeDateKey("2026-01-05T00:00:00.000"), "05-01-2026");
  assert.equal(time.normalizeDateKey("garbage"), null);
  assert.deepEqual(new Set(time.legacyDateVariants("05-01-2026")), new Set(["05-01-2026", "5-1-2026", "05-1-2026", "5-01-2026"]));
});

test("monthKey handles January → previous December", () => {
  assert.equal(time.monthKey(ist(2027, 1, 1, 0, 5), -1), "12-2026");
  assert.equal(time.monthKey(ist(2026, 10, 15, 12, 0)), "10-2026");
});

test("stage / language normalization", () => {
  for (const s of ["Stage 1", "stage1", "STAGE 1", "Stage1", 1]) assert.equal(norm.normStage(s), "stage1");
  assert.equal(norm.normStage("stage9"), null);
  assert.equal(norm.normLanguage("hindi"), "Hindi");
  assert.equal(norm.normLanguage("Club"), null);
  assert.equal(norm.escapeRegex(".*"), "\\.\\*");
  assert.deepEqual(norm.cleanAccessMap({ stage1: true, stage2: "yes", hacked: true }), {
    stage1: true, stage2: false, stage3: false, stage4: false, stage5: false, stage6: false, stage7: false,
  });
});

test("student batch status is computed in IST (old bug: always Late on UTC servers)", () => {
  const { evaluateStudentBatchStatus: f } = _internal;
  assert.equal(f(ist(2026, 10, 15, 5, 31), "05:30 AM - 07:00 AM"), "Present");
  assert.equal(f(ist(2026, 10, 15, 5, 10), "5:30 AM - 7:00 AM"), "Present"); // 20 min early
  assert.equal(f(ist(2026, 10, 15, 5, 40), "5:30 AM - 7:00 AM"), "Late");
  assert.equal(f(ist(2026, 10, 15, 18, 32), "6:30 PM - 8:00 PM"), "Present");
});

test("teacher status windows", () => {
  const { evaluateTeacherStatus: f } = _internal;
  assert.equal(f(ist(2026, 10, 15, 5, 28)), "Present");
  assert.equal(f(ist(2026, 10, 15, 15, 33)), "Present");
  assert.equal(f(ist(2026, 10, 15, 6, 0)), "Late");
});

test("online minutes are never double-counted across syncs", () => {
  const { closeSegment } = _internal;
  const start = ist(2026, 10, 15, 5, 30);
  const rec = { joinTime: start, secondsSpent: 0, totalMinutesSpent: 0 };

  // sync every 10 minutes for 40 minutes (old code would have given 10+20+30+40 = 100 → capped 90)
  for (let i = 1; i <= 4; i++) {
    const now = new Date(start.getTime() + i * 10 * 60000);
    closeSegment(rec, now);
    rec.joinTime = now;
  }
  assert.equal(rec.totalMinutesSpent, 40);

  // capped at 90
  closeSegment(rec, new Date(start.getTime() + 300 * 60000));
  assert.equal(rec.totalMinutesSpent, 90);
});

test("online status thresholds", () => {
  const { deriveOnlineStatus: f } = _internal;
  assert.equal(f(50, "Late"), "Present");
  assert.equal(f(20, "Present"), "Partial");
  assert.equal(f(5, "Late"), "Late");
  assert.equal(f(0, "Absent"), "Absent");
});

test("geofence distance", () => {
  const { haversineMeters } = _internal;
  assert.ok(haversineMeters(17.729417, 83.312231, 17.729417, 83.312231) < 1);
  const d = haversineMeters(17.729417, 83.312231, 17.7303, 83.312231); // ~98 m north
  assert.ok(d > 90 && d < 110, `got ${d}`);
});

// ---------------- batch timings ----------------
const { BATCHES, normBatch } = require("../utils/batches");

test("7 batch timings, canonical labels", () => {
  assert.equal(BATCHES.length, 7);
  assert.equal(BATCHES[0].label, "05:30 AM - 07:00 AM");
  assert.equal(BATCHES[6].label, "06:30 PM - 08:00 PM");
});

test("normBatch accepts every format the apps send", () => {
  assert.equal(normBatch("batch1"), "05:30 AM - 07:00 AM");
  assert.equal(normBatch(5), "03:30 PM - 05:00 PM");
  assert.equal(normBatch("5:30 AM - 7:00 AM"), "05:30 AM - 07:00 AM"); // admin filter style
  assert.equal(normBatch("03:30 - 05:00"), "03:30 PM - 05:00 PM"); // poster style, no AM/PM
  assert.equal(normBatch("06:30 - 08:00"), "06:30 PM - 08:00 PM");
  assert.equal(normBatch("10:30 AM - 12:00 PM"), "10:30 AM - 12:00 PM");
  assert.equal(normBatch("8:00 AM"), null);
  assert.equal(normBatch("all"), null);
  assert.equal(normBatch(""), null);
});

test("each stage can have its own timing (Stage 1 morning, Stage 2 evening)", () => {
  const { stageBatch, findBatchConflict } = require("../utils/batches");
  const rocky = {
    batchTime: "03:30 PM - 05:00 PM", // signup choice
    englishAccess: { stage1: true, stage2: true },
    englishBatch: { stage1: "05:30 AM - 07:00 AM", stage2: "03:30 PM - 05:00 PM" },
  };
  assert.equal(stageBatch(rocky, "English", "stage1"), "05:30 AM - 07:00 AM");
  assert.equal(stageBatch(rocky, "English", "stage2"), "03:30 PM - 05:00 PM");
  assert.equal(findBatchConflict(rocky), null);

  // Same timing for two enabled stages is impossible → clash message
  rocky.englishBatch.stage2 = "05:30 AM - 07:00 AM";
  assert.match(findBatchConflict(rocky), /Stage 1 and English Stage 2/);

  // Stage without its own timing falls back to the signup timing
  const newbie = { batchTime: "batch2", englishAccess: { stage1: true }, englishBatch: {} };
  assert.equal(stageBatch(newbie, "English", "stage1"), "07:00 AM - 08:30 AM");
});

test("report: a day with two stages takes the best status and adds minutes", () => {
  const { _internal } = require("../Controllers/UserContollers/reportController");
  const day = _internal.combineDay([
    { stage: "stage1", language: "English", status: "Late", totalMinutesSpent: 40 },
    { stage: "stage2", language: "English", status: "Present", totalMinutesSpent: 85 },
  ]);
  assert.equal(day.status, "Present");
  assert.equal(day.minutes, 125);
  assert.equal(day.details.length, 2);

  const t = _internal.finishTotals({ present: 20, late: 3, partial: 1, absent: 2, holiday: 4, workingDays: 26, minutes: 1800 });
  assert.equal(t.attended, 24);
  assert.equal(t.percentage, 92);
  assert.equal(t.hours, 30);
});

test("leaderboard: working days skip Sundays; ranking = %, then present days, then minutes", () => {
  const { _internal } = require("../Controllers/UserContollers/leaderboardController");
  // 1–31 Oct 2026: 4 Sundays (4, 11, 18, 25) → 27 working days
  assert.equal(_internal.countWorkingDays(20261001, 20261031), 27);
  assert.equal(_internal.countWorkingDays(20261005, 20261004), 0);

  const ranked = _internal.rankPeople([
    { name: "A", percentage: 90, present: 20, minutes: 1000 },
    { name: "B", percentage: 95, present: 18, minutes: 900 },
    { name: "C", percentage: 90, present: 22, minutes: 800 },
  ]);
  assert.deepEqual(ranked.map((p) => p.name), ["B", "C", "A"]);
});

test("practice: index matches by student + stage + language", async () => {
  const Practice = require("../Models/practice");
  const original = Practice.find;
  Practice.find = () => ({
    select: () => ({
      lean: async () => [
        { userId: "u1", language: "English", stage: "stage1", practicedAt: new Date(), trainerName: "Mam" },
        { userId: "u2", language: "English", stage: "stage2", practicedAt: new Date(), trainerName: "Mam" },
      ],
    }),
  });
  try {
    const { practiceIndex } = require("../Controllers/UserContollers/practiceController");
    const idx = await practiceIndex({ date: "16-10-2026" });
    assert.ok(idx.get("u1|stage1|English"));
    assert.equal(idx.get("u1|stage2|English"), undefined); // Stage 2 row is NOT practiced
    assert.equal(idx.get("u2").trainerName, "Mam");
  } finally {
    Practice.find = original;
  }
});

test("batch window: 03:30 PM student can join 15:00–17:15 only", () => {
  const { inBatchWindow, batchAt } = require("../utils/batches");
  const own = "03:30 PM - 05:00 PM";
  const at = (h, m) => h * 60 + m;
  assert.equal(inBatchWindow(own, at(15, 0)), true); // 30 min early
  assert.equal(inBatchWindow(own, at(16, 10)), true);
  assert.equal(inBatchWindow(own, at(17, 15)), true); // 15 min grace
  assert.equal(inBatchWindow(own, at(9, 10)), false); // morning class → other batch
  assert.equal(inBatchWindow(own, at(18, 40)), false);
  assert.equal(inBatchWindow("", at(9, 10)), true); // no timing set → allowed
  assert.equal(batchAt(at(9, 10)).label, "09:00 AM - 10:30 AM");
  assert.equal(batchAt(at(14, 39)), null); // 2:39 PM: no class running
  assert.equal(batchAt(at(15, 10)).label, "03:30 PM - 05:00 PM"); // starting soon
});

test("other-batch list needs a staff token in strict mode / route exists", async () => {
  const router = require("../Routes/UserRoutes/authRoute");
  const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
  assert.ok(paths.includes("/admin/batch-visitors"));
});

test("stream: server builds one call id per class per day", () => {
  process.env.STREAM_API_KEY = process.env.STREAM_API_KEY || "k";
  const { _internal } = require("../Controllers/UserContollers/streamController");
  const day = require("../utils/time").dateKey().split("-").reverse().join("");
  assert.equal(_internal.buildCallId({ language: "English", stage: "stage1", section: "A", type: "class" }), `english_stage1_seca_class_${day}`);
  assert.equal(_internal.buildCallId({ language: "Hindi", stage: "stage2", section: "B", type: "class" }), `hindi_stage2_class_${day}`);
});
