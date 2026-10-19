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

test("student: on time = join by start + 7 min (05:30 class → by 05:37), computed in IST", () => {
  const { evaluateStudentBatchStatus: f } = _internal;
  assert.equal(f(ist(2026, 10, 15, 5, 31), "05:30 AM - 07:00 AM"), "Present");
  assert.equal(f(ist(2026, 10, 15, 5, 10), "5:30 AM - 7:00 AM"), "Present"); // 20 min early
  assert.equal(f(ist(2026, 10, 15, 5, 37), "5:30 AM - 7:00 AM"), "Present"); // last on-time minute
  assert.equal(f(ist(2026, 10, 15, 5, 38), "5:30 AM - 7:00 AM"), "Late");
  assert.equal(f(ist(2026, 10, 15, 18, 36), "6:30 PM - 8:00 PM"), "Present");
  assert.equal(f(ist(2026, 10, 15, 15, 41), "03:30 PM - 05:00 PM"), "Late");
});

test("trainer: morning 05:25–05:27 / afternoon 02:55–02:57 = Present, after = Late", () => {
  const { evaluateTeacherStatus: f, arrivalInfo } = _internal;
  assert.equal(f(ist(2026, 10, 15, 5, 25)), "Present");
  assert.equal(f(ist(2026, 10, 15, 5, 27)), "Present");
  assert.equal(f(ist(2026, 10, 15, 5, 10)), "Present"); // early is fine
  assert.equal(f(ist(2026, 10, 15, 5, 28)), "Late");
  assert.equal(f(ist(2026, 10, 15, 14, 56)), "Present");
  assert.equal(f(ist(2026, 10, 15, 14, 58)), "Late");
  const t = arrivalInfo({ role: "teacher" }, ist(2026, 10, 15, 5, 34), null);
  assert.deepEqual(t, { status: "Late", lateByMinutes: 7 });
  const st = arrivalInfo({ role: "student" }, ist(2026, 10, 15, 5, 41), "05:30 AM - 07:00 AM");
  assert.deepEqual(st, { status: "Late", lateByMinutes: 4 });
});

test("trainer shifts: before noon = morning, after = afternoon; old records get a shift from their time", () => {
  const rules = require("../utils/attendanceRules");
  assert.equal(rules.shiftAt(5 * 60 + 26).key, "morning");
  assert.equal(rules.shiftAt(14 * 60 + 56).key, "afternoon");
  assert.equal(rules.shiftOfRecord({ batchTime: "Afternoon shift" }), "afternoon");
  assert.equal(rules.shiftOfRecord({ batchTime: "Live Stream", firstJoinAt: ist(2026, 10, 15, 15, 1) }), "afternoon");
  assert.equal(rules.rulesSummary().trainerShifts[0].window, "05:25 AM – 05:27 AM");
  assert.equal(rules.rulesSummary().trainerShifts[1].window, "02:55 PM – 02:57 PM");
});

test("online sessions: every join/leave is kept (05:34–05:50, 06:02–…)", () => {
  const { openSession, closeSession } = _internal;
  const rec = { sessions: [] };
  openSession(rec, ist(2026, 10, 15, 5, 34));
  closeSession(rec, ist(2026, 10, 15, 5, 50));
  rec.lastActiveTime = ist(2026, 10, 15, 5, 50);
  openSession(rec, ist(2026, 10, 15, 6, 2));
  assert.equal(rec.sessions.length, 2);
  assert.equal(rec.sessions[0].out.getTime(), ist(2026, 10, 15, 5, 50).getTime());
  assert.equal(rec.sessions[1].out, null);
  // app killed without "leave" → next join closes the open one at the last activity
  rec.lastActiveTime = ist(2026, 10, 15, 6, 20);
  openSession(rec, ist(2026, 10, 15, 6, 30));
  assert.equal(rec.sessions[1].out.getTime(), ist(2026, 10, 15, 6, 20).getTime());
});

test("holiday dates: a range becomes one date per day (across months)", () => {
  const { _internal: h } = require("../Controllers/UserContollers/holidayController");
  const from = h.keyToUtc("30-10-2026");
  const days = [0, 1, 2].map((i) => h.utcToKey(from + i * 86400000));
  assert.deepEqual(days, ["30-10-2026", "31-10-2026", "01-11-2026"]);
  const { holidayApplies } = require("../utils/holidays");
  assert.equal(holidayApplies({ appliesTo: "all" }, "teacher"), true);
  assert.equal(holidayApplies({ appliesTo: "students" }, "teacher"), false);
  assert.equal(holidayApplies({ appliesTo: "trainers" }, "student"), false);
  assert.equal(holidayApplies(null, "student"), false);
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
  assert.equal(f(50, "Late"), "Late"); // stayed, but came late → stays Late
  assert.equal(f(50, "Present"), "Present");
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
  assert.equal(_internal.buildCallId({ language: "English", stage: "stage1", section: "A", type: "class" }), `english_stage1_seca_class_${day}_v3`);
  assert.equal(_internal.buildCallId({ language: "Hindi", stage: "stage2", section: "B", type: "class" }), `hindi_stage2_class_${day}_v3`);
});

test("batch summary: own timing, other timing and absent are split correctly", () => {
  const { _internal } = require("../Controllers/UserContollers/attendanceController");
  const students = [
    { _id: "r1", name: "Rocky", englishAccess: { stage1: true }, englishBatch: { stage1: "03:30 PM - 05:00 PM" } },
    { _id: "m1", name: "Murali", englishAccess: { stage1: true }, englishBatch: { stage1: "09:00 AM - 10:30 AM" } },
    { _id: "g1", name: "Girish", englishAccess: { stage1: true }, englishBatch: { stage1: "09:00 AM - 10:30 AM" } },
    { _id: "n1", name: "Nobody", englishAccess: { stage1: true }, englishBatch: {} },
  ];
  const records = [
    // Rocky (3:30 PM) attended the 9:00 AM class instead → counted, shown as other timing
    { userId: "r1", stage: "stage1", language: "English", userMode: "offline", status: "Present", totalMinutesSpent: 80, otherBatch: true, joinedBatch: "09:00 AM - 10:30 AM" },
    { userId: "m1", stage: "stage1", language: "English", userMode: "offline", status: "Late", totalMinutesSpent: 60, joinedBatch: "09:00 AM - 10:30 AM" },
  ];
  const out = _internal.summarizeBatches({ students, records, language: "English", stage: "stage1" });
  const nine = out.find((b) => b.batch === "09:00 AM - 10:30 AM");
  const pm = out.find((b) => b.batch === "03:30 PM - 05:00 PM");
  const none = out.find((b) => b.batch === "");
  assert.equal(nine.counts.total, 2);
  assert.equal(nine.counts.late, 1);
  assert.equal(nine.counts.absent, 1); // Girish
  assert.equal(nine.counts.fromOther, 1); // Rocky came here
  assert.equal(pm.counts.total, 1);
  assert.equal(pm.counts.attended, 1); // Rocky still counted for his own timing
  assert.equal(pm.counts.elsewhere, 1);
  assert.equal(pm.counts.absent, 0);
  assert.equal(none.counts.total, 1);
  assert.equal(none.counts.absent, 1);
});

test("batch summary route exists", () => {
  const router = require("../Routes/UserRoutes/authRoute");
  const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
  assert.ok(paths.includes("/admin/batch-summary"));
});

test("best student: attendance 50% + practice rating 30% + tests 20%", () => {
  const { _internal } = require("../Controllers/UserContollers/leaderboardController");
  assert.equal(_internal.overallScore({ percentage: 100, practicePct: 100, testPct: 100 }), 100);
  assert.equal(_internal.overallScore({ percentage: 80, practicePct: (4 / 5) * 100, testPct: 70 }), 78);
  const ranked = _internal.rankStudents([
    { name: "A", score: 70, percentage: 90, practiceAvg: 3, testAvg: 50, minutes: 100 },
    { name: "B", score: 85, percentage: 80, practiceAvg: 5, testAvg: 90, minutes: 90 },
  ]);
  assert.equal(ranked[0].name, "B");
});

test("practice rating accepts only 1–5 and /practice/rate exists", () => {
  const { _internal } = require("../Controllers/UserContollers/practiceController");
  assert.equal(_internal.cleanRating(4), 4);
  assert.equal(_internal.cleanRating("5"), 5);
  assert.equal(_internal.cleanRating(0), 0);
  assert.equal(_internal.cleanRating(9), 0);
  const router = require("../Routes/UserRoutes/practiceRoute");
  const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
  assert.ok(paths.includes("/rate"));
});

test("class load: counts per stage, section and timing (online English only has sections)", () => {
  const { _internal } = require("../Controllers/UserContollers/classLoadController");
  const students = [
    { _id: "1", mode: "online", onlineSection: "A", batchTime: "05:30 AM - 07:00 AM", englishAccess: { stage1: true }, englishBatch: {} },
    { _id: "2", mode: "online", onlineSection: "a", englishAccess: { stage1: true, stage2: true }, englishBatch: { stage1: "3:30 PM", stage2: "batch1" } },
    { _id: "3", mode: "online", onlineSection: "B", englishAccess: { stage1: true }, englishBatch: { stage1: "05:30 AM - 07:00 AM" } },
    { _id: "4", mode: "offline", onlineSection: "None", englishAccess: { stage1: true }, englishBatch: { stage1: "05:30 AM - 07:00 AM" } },
    { _id: "5", mode: "online", onlineSection: "None", hindiAccess: { stage1: true }, hindiBatch: { stage1: "07:00 AM - 08:30 AM" } },
  ];
  const load = _internal.summarizeLoad(students, "3");
  const s1 = load.online.English.stage1;
  assert.equal(s1.total, 2);
  assert.equal(s1.sections.A, 2);
  assert.equal(s1.sections.B, 0); // excluded student
  assert.equal(s1.timings["05:30 AM - 07:00 AM"], 1);
  assert.equal(s1.timings["03:30 PM - 05:00 PM"], 1);
  assert.equal(s1.matrix.A["03:30 PM - 05:00 PM"], 1);
  assert.equal(load.online.English.stage2.sections.A, 1);
  assert.equal(load.offline.English.stage1.total, 1);
  assert.equal(load.offline.English.stage1.sections, undefined);
  assert.equal(load.online.Hindi.stage1.timings["07:00 AM - 08:30 AM"], 1);
  assert.equal(load.online.Hindi.stage1.sections, undefined);
});

test("top rated: average first, but needs enough ratings to win", () => {
  const { _internal } = require("../Controllers/UserContollers/leaderboardController");
  const r = _internal.rankRatings(
    [
      { name: "Lucky", sum: 5, rated: 1, fiveStar: 1 },
      { name: "Steady", sum: 18, rated: 4, fiveStar: 2 },
      { name: "Good", sum: 16, rated: 4, fiveStar: 1 },
    ],
    3
  );
  assert.deepEqual(r.map((x) => x.name), ["Steady", "Good", "Lucky"]);
  assert.equal(r[0].avg, 4.5);
  assert.equal(r[2].qualified, false);
  assert.deepEqual(_internal.topTags([["Fluency", "Grammar"], ["Fluency"], []], 2), ["Fluency", "Grammar"]);
  const router = require("../Routes/UserRoutes/authRoute");
  const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
  assert.ok(paths.includes("/leaderboard/ratings"));
  assert.ok(paths.includes("/admin/class-load"));
});

test("posters & reels: upload image + reel, students see only live posts for their mode", async () => {
  const cl = require("../utils/cloudinary");
  cl.uploadPromoImage = async () => ({ url: "https://img/x.jpg", publicId: "p/img", width: 1080, height: 1350 });
  cl.uploadPromoVideo = async () => ({ url: "https://vid/x.mp4", thumbUrl: "https://vid/x.jpg", publicId: "p/vid", duration: 20 });
  const Promo = require("../Models/promo");
  const origCreate = Promo.create;
  Promo.create = async (doc) => ({ _id: "pr1", ...doc });
  try {
    const { createPromo, _internal } = require("../Controllers/UserContollers/promoController");
    const out = {};
    const res = { status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } };

    await createPromo({ files: {}, body: {} }, res);
    assert.equal(out.code, 400); // nothing attached

    await createPromo(
      {
        files: { image: [{ size: 1000, buffer: Buffer.from("i") }], video: [{ size: 5000, buffer: Buffer.from("v") }] },
        body: { title: "Dussehra — 10 days to go", targetMode: "online", endsAt: "" },
        user: { _id: "admin1", name: "Admin" },
      },
      res
    );
    assert.equal(out.code, 201);
    assert.equal(out.body.promo.image.url, "https://img/x.jpg");
    assert.equal(out.body.promo.video.thumbUrl, "https://vid/x.jpg");
    assert.equal(out.body.promo.targetMode, "online");
    assert.equal(out.body.promo.endsAt, null);

    const now = new Date("2026-10-17T10:00:00Z");
    const p = { active: true, targetMode: "online", image: { url: "u" }, video: {}, endsAt: null };
    assert.equal(_internal.isLive(p, "online", now), true);
    assert.equal(_internal.isLive(p, "offline", now), false);
    assert.equal(_internal.isLive({ ...p, targetMode: "all" }, "offline", now), true);
    assert.equal(_internal.isLive({ ...p, active: false }, "online", now), false);
    assert.equal(_internal.isLive({ ...p, endsAt: "2026-10-16T00:00:00Z" }, "online", now), false);
    assert.equal(_internal.isLive({ ...p, image: {} }, "online", now), false);
    assert.equal(_internal.publicView({ ...p, _id: "1", video: {} }).video, null);
  } finally {
    Promo.create = origCreate;
  }
  const router = require("../Routes/UserRoutes/promoRoute");
  const paths = router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
  for (const p of ["get /active", "get /", "post /", "patch /:id", "delete /:id"]) assert.ok(paths.includes(p), p);
});

test("special days: rain + principal class call ids, time parsing, arrival", () => {
  process.env.STREAM_API_KEY = process.env.STREAM_API_KEY || "k";
  const { _internal } = require("../Controllers/UserContollers/streamController");
  const day = require("../utils/time").dateKey().split("-").reverse().join("");
  assert.equal(_internal.buildOfflineCallId({ language: "English", stage: "stage2" }), `offline_english_stage2_class_${day}_v3`);
  assert.equal(_internal.buildAssemblyCallId({ sessionKey: "ab12cd" }), `assembly_ab12cd_${day}_v3`);

  const cm = require("../utils/classMode");
  assert.equal(cm.parseTime("11:00 AM"), 660);
  assert.equal(cm.parseTime("3:30 pm"), 930);
  assert.equal(cm.parseTime("12:05 AM"), 5);
  assert.equal(cm.parseTime("25:00"), null);
  assert.equal(cm.formatTime(930), "03:30 PM");
  assert.equal(cm.assemblyArrival({ startMinutes: 660 }, 670), "Present");
  assert.equal(cm.assemblyArrival({ startMinutes: 660 }, 690), "Late");

  const { _assembly } = require("../Controllers/UserContollers/attendanceController");
  const student = {
    role: "student",
    englishAccess: { stage1: true, stage2: true },
    hindiAccess: { stage1: true },
    englishBatch: {},
    hindiBatch: {},
  };
  const stages = _assembly.assemblyStagesOf(student, { language: "English", stage: "stage1" });
  assert.equal(stages.length, 3); // attendance for every stage the student has
  const trainer = { role: "teacher", language: "Hindi", teacherStage: "stage4" };
  assert.deepEqual(_assembly.assemblyStagesOf(trainer, { language: "English", stage: "stage1" }), [{ language: "Hindi", stage: "stage4" }]);

  const router = require("../Routes/UserRoutes/classModeRoute");
  const paths = router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
  for (const p of ["get /", "post /rain", "post /assembly"]) assert.ok(paths.includes(p), p);
});

// ---- 📝 tests: versions + nothing expires ----
test("test model has no TTL index and results keep a version", () => {
  const Test = require("../Models/test");
  const Result = require("../Models/result");
  const ttl = (schema) => schema.indexes().some(([, opts]) => opts && opts.expireAfterSeconds !== undefined);
  assert.equal(ttl(Test.schema), false);
  assert.equal(ttl(Result.schema), false);
  for (const s of [Test.schema, Result.schema]) {
    for (const [, path] of Object.entries(s.paths)) assert.equal(path.options && path.options.expires, undefined);
  }
  assert.ok(Result.schema.path("testVersion"));
  const { _internal } = require("../Controllers/UserContollers/testController");
  const d = new Date("2026-10-18T05:00:00Z");
  assert.equal(_internal.versionOf({ publishedAt: d, createdAt: new Date(0) }), d.getTime());
  assert.equal(_internal.versionOf({ createdAt: d }), d.getTime());
  assert.equal(_internal.versionOf(null), 0);
});

test("test routes load", () => {
  const r = require("../Routes/UserRoutes/testRoute");
  const paths = r.stack.map((l) => l.route && l.route.path);
  for (const p of ["/admin/get-test", "/admin/test-active", "/user/test-overview", "/admin/delete-test"]) assert.ok(paths.includes(p), p);
});

test("test countdown is calculated from the server start time", () => {
  const { _internal } = require("../Controllers/UserContollers/testController");
  assert.equal(_internal.secondsLeftFor(null, { durationMinutes: 5 }), null);
  const twoMinAgo = new Date(Date.now() - 120000);
  const left = _internal.secondsLeftFor({ startedAt: twoMinAgo }, { durationMinutes: 5 });
  assert.ok(left >= 179 && left <= 181, String(left));
  assert.equal(_internal.secondsLeftFor({ startedAt: new Date(Date.now() - 600000) }, { durationMinutes: 5 }), 0);
});

test("promo: Instagram reel links are parsed and count as media", () => {
  const { _parseInstagram, _internal } = require("../Controllers/UserContollers/promoController");
  assert.deepEqual(_parseInstagram("https://www.instagram.com/reel/DAbc123xyz/?igsh=MTc4"), {
    url: "https://www.instagram.com/reel/DAbc123xyz/",
    code: "DAbc123xyz",
    kind: "reel",
  });
  assert.equal(_parseInstagram("https://instagram.com/reels/C9zz_-AbC").kind, "reel");
  assert.equal(_parseInstagram("https://www.instagram.com/letsspeak/p/Cxy12345/").kind, "p");
  assert.equal(_parseInstagram("https://youtube.com/watch?v=1"), null);
  assert.equal(_parseInstagram(""), null);
  const p = { active: true, targetMode: "all", image: {}, video: {}, instagram: { code: "DAbc123xyz", kind: "reel", url: "x" } };
  assert.equal(_internal.isLive(p, "online"), true);
  assert.equal(_internal.publicView(p).instagram.embedUrl, "https://www.instagram.com/reel/DAbc123xyz/embed/");
});

test("report: practice ratings are summarised day + stage wise", () => {
  const { _internal } = require("../Controllers/UserContollers/reportController");
  const out = _internal.summarizePractice([
    { language: "English", stage: "stage1", rating: 4 },
    { language: "English", stage: "stage1", rating: 5 },
    { language: "English", stage: "stage2", rating: 0 },
    { language: "Hindi", stage: "stage1", rating: 3 },
  ]);
  assert.equal(out.count, 4);
  assert.equal(out.rated, 3);
  assert.equal(out.averageRating, 4);
  const e1 = out.byStage.find((s) => s.language === "English" && s.stage === "stage1");
  assert.deepEqual([e1.count, e1.rated, e1.averageRating], [2, 2, 4.5]);
  assert.equal(out.byStage.find((s) => s.stage === "stage2").averageRating, 0);
});

test("best student: class keys, score and ranking", () => {
  const { _internal } = require("../Controllers/UserContollers/bestStudentController");
  const on = _internal.classKey({ mode: "online", onlineSection: "b" }, "English", "stage1");
  assert.equal(on.key, "English|stage1|online|B");
  assert.equal(on.label, "English • Stage 1 • Online • Section B");
  const off = _internal.classKey({ mode: "offline", onlineSection: "B" }, "English", "stage1");
  assert.equal(off.key, "English|stage1|offline|"); // offline has no sections
  assert.equal(_internal.classKey({ mode: "online" }, "Hindi", "stage2").key, "Hindi|stage2|online|");
  assert.equal(_internal.scoreOf({ percentage: 100, practiceAvg: 5, testAvg: 100 }), 100);
  assert.equal(_internal.scoreOf({ percentage: 80, practiceAvg: 4, testAvg: 50 }), 74); // 40 + 24 + 10
  const people = _internal.rank([
    { name: "Ramesh", score: 70, percentage: 90, practiceAvg: 3, testAvg: 60, minutes: 10 },
    { name: "Lokesh", score: 82, percentage: 85, practiceAvg: 4.5, testAvg: 70, minutes: 5 },
    { name: "Sai", score: 70, percentage: 95, practiceAvg: 3, testAvg: 40, minutes: 1 },
  ]);
  assert.deepEqual(people.map((p) => p.name), ["Lokesh", "Sai", "Ramesh"]);
  const v = _internal.viewFor(people.map((p, i) => ({ ...p, userId: String(i), phone: "9", rank: i + 1 })), "2", false);
  assert.equal(v.winner.name, "Lokesh");
  assert.equal(v.me.name, "Ramesh");
  assert.equal(v.winner.phone, undefined); // phones only for admins
});
