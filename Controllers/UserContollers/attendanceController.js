const Attendance = require("../../Models/attendance");
const User = require("../../Models/users");
const SectionMerge = require("../../Models/sectionMerge");
const {
  dateKey,
  istMinutesOfDay,
  normalizeDateKey,
  legacyDateVariants,
  istDayRange,
  parseClockToMinutes,
} = require("../../utils/time");
const {
  normStage,
  stageNumber,
  stageVariants,
  normLanguage,
  normMode,
  normSection,
  isAll,
  isValidId,
  STAFF_ROLES,
} = require("../../utils/normalize");
const { normBatch, stageBatch, enabledStageTimings, inBatchWindow, batchAt } = require("../../utils/batches");
const BatchVisit = require("../../Models/batchVisit");
const { practiceIndex } = require("./practiceController");
const Practice = require("../../Models/practice");

// =====================================================
// CONFIG (override on Render → Environment)
// =====================================================
const MAX_CLASS_MINUTES = 90;
const PRESENT_MINUTES = 45;
const PARTIAL_MINUTES = 15;
const DEFAULT_BATCH = "05:30 AM - 07:00 AM";

const INSTITUTE_LAT = Number(process.env.INSTITUTE_LAT || 17.729417);
const INSTITUTE_LNG = Number(process.env.INSTITUTE_LNG || 83.312231);
// Phone GPS drifts 20-50 m indoors; the app checks 40 m, server allows a little more
const GEOFENCE_RADIUS_M = Number(process.env.GEOFENCE_RADIUS_M || 100);

// Trainer shift start times (IST). Present = within ±5 min of one of these.
const TEACHER_START_MINUTES = (process.env.TEACHER_START_TIMES || "05:30,15:30")
  .split(",")
  .map((t) => parseClockToMinutes(t.trim()))
  .filter((m) => m !== null);

// =====================================================
// HELPERS
// =====================================================
const isStaff = (user) => !!user && STAFF_ROLES.includes(user.role);

// With a token we trust ONLY the token. Without one (transition mode) we fall back to the body.
const actingUserId = (req) => (req.user ? String(req.user._id) : req.body.userId || req.query.userId);

const evaluateTeacherStatus = (when) => {
  const mins = istMinutesOfDay(when);
  return TEACHER_START_MINUTES.some((start) => Math.abs(mins - start) <= 5) ? "Present" : "Late";
};

const evaluateStudentBatchStatus = (when, batchTimeStr) => {
  const start = parseClockToMinutes(batchTimeStr) ?? parseClockToMinutes(DEFAULT_BATCH);
  const diff = istMinutesOfDay(when) - start;
  if (diff >= -30 && diff <= 5) return "Present";
  return "Late";
};

// Which batch a check-in belongs to: what the app sent, else the student's timing for THIS stage
const resolveBatch = (user, sentBatch, language, stage) =>
  normBatch(sentBatch) || (user && user.role === "student" ? stageBatch(user, language, stage) || null : null);

const evaluateArrival = (user, when, batchTime) =>
  isStaff(user) ? evaluateTeacherStatus(when) : evaluateStudentBatchStatus(when, batchTime);

// Same rule the trainer roster always used, now stored so every screen agrees
const deriveOnlineStatus = (minutes, arrivalStatus) => {
  if (minutes >= PRESENT_MINUTES) return "Present";
  if (minutes >= PARTIAL_MINUTES) return "Partial";
  return arrivalStatus && arrivalStatus !== "Absent" ? arrivalStatus : "Absent";
};

// Closes the open segment [joinTime → now] and adds it to the counters.
// joinTime is then moved forward, so a segment is NEVER counted twice.
const closeSegment = (record, now) => {
  if (!record.joinTime) return;
  const seconds = Math.max(0, Math.floor((now - new Date(record.joinTime)) / 1000));
  const total = Math.min((record.secondsSpent || (record.totalMinutesSpent || 0) * 60) + seconds, MAX_CLASS_MINUTES * 60);
  record.secondsSpent = total;
  record.totalMinutesSpent = Math.floor(total / 60);
  record.lastActiveTime = now;
};

const haversineMeters = (lat1, lng1, lat2, lng2) => {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

const statusRank = { Present: 3, Late: 2, Partial: 1, Absent: 0 };

// Old data can contain duplicates (same user, same day, different date spelling).
// Keep the best one: higher status first, then more minutes.
const pickBest = (a, b) => {
  if (!a) return b;
  const ra = statusRank[a.status] || 0;
  const rb = statusRank[b.status] || 0;
  if (rb !== ra) return rb > ra ? b : a;
  return (b.totalMinutesSpent || 0) > (a.totalMinutesSpent || 0) ? b : a;
};

const liveMinutes = (record, now = new Date()) => {
  let secs = record.secondsSpent || (record.totalMinutesSpent || 0) * 60;
  if (record.joinTime) secs += Math.max(0, (now - new Date(record.joinTime)) / 1000);
  return Math.min(Math.floor(secs / 60), MAX_CLASS_MINUTES);
};

// =====================================================
// OFFLINE: GPS CHECK-IN (students + trainers)
// POST /api/user/mark-attendance  { userId, stage, lat, lng, language, batchTime }
// =====================================================
const markAttendance = async (req, res) => {
  try {
    const userId = actingUserId(req);
    if (!isValidId(userId)) return res.status(400).json({ message: "Valid userId required" });

    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ message: "Location is required for check-in" });
    }
    const distance = haversineMeters(lat, lng, INSTITUTE_LAT, INSTITUTE_LNG);
    if (distance > GEOFENCE_RADIUS_M) {
      return res.status(403).json({ message: `You are ${Math.round(distance)}m away from the institute.` });
    }

    const user = await User.findById(userId).lean();
    if (!user) return res.status(404).json({ message: "User not found" });

    const now = new Date();
    const date = dateKey(now);
    const stage = normStage(req.body.stage) || normStage(user.teacherStage) || "stage1";
    const language = normLanguage(req.body.language) || user.language || "English";

    const existing = await Attendance.findOne({
      userId,
      date: { $in: legacyDateVariants(date) },
      stage: { $in: stageVariants(stage) },
      language,
      markedAt: { $exists: true, $ne: null },
    }).lean();

    if (existing) {
      return res.status(200).json({ message: `Already marked as ${existing.status}`, record: existing });
    }

    const batchTime = resolveBatch(user, req.body.batchTime, language, stage) || DEFAULT_BATCH;
    const status = evaluateArrival(user, now, batchTime);

    const record = await Attendance.findOneAndUpdate(
      { userId, stage, date, language },
      {
        $set: {
          userName: user.name,
          userPhone: user.phone,
          userMode: user.mode || "offline",
          batchTime,
          status,
          arrivalStatus: status,
          markedAt: now,
          location: { lat, lng },
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(200).json({ message: `Marked as ${status}`, record });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(200).json({ message: "Attendance already recorded for this class today" });
    }
    console.error("Mark Attendance Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// ONLINE: JOIN / SYNC / LEAVE
// All times come from the SERVER clock (client times are ignored → no spoofing).
// =====================================================
const joinOnlineClass = async (req, res) => {
  try {
    const userId = actingUserId(req);
    if (!isValidId(userId)) return res.status(400).json({ message: "Valid userId required" });

    const user = await User.findById(userId).lean();
    if (!user) return res.status(404).json({ message: "User not found" });

    const now = new Date();
    const date = dateKey(now);
    const stage = normStage(req.body.stage) || normStage(user.teacherStage) || "stage1";
    const language = normLanguage(req.body.language) || user.language || "English";
    const batchTime = resolveBatch(user, req.body.batchStartTime || req.body.batchTime, language, stage);

    // 🚫 Student joined outside their own batch time → let them listen, but
    // do NOT mark attendance. Saved as an "other batch" join for admin/trainer.
    if (user.role === "student" && process.env.ENFORCE_BATCH_WINDOW !== "false") {
      const own = stageBatch(user, language, stage);
      const mins = istMinutesOfDay(now);
      if (own && !inBatchWindow(own, mins)) {
        const running = batchAt(mins);
        const joinedBatch = running ? running.label : "Outside class hours";
        await BatchVisit.findOneAndUpdate(
          { userId, date, language, stage, joinedBatch },
          {
            $set: {
              userName: user.name,
              userPhone: user.phone,
              section: language === "Hindi" ? "" : String(user.onlineSection || "").toUpperCase(),
              ownBatch: own,
              lastJoinedAt: now,
            },
            $setOnInsert: { joinedAt: now },
            $inc: { joinCount: 1 },
          },
          { upsert: true, setDefaultsOnInsert: true }
        );
        if (req.io) req.io.to("admin_room").emit("attendance_update", { type: "batch_visit", userId });
        return res.status(200).json({
          outsideBatch: true,
          attendanceId: null,
          ownBatch: own,
          joinedBatch,
          message: `Your class time is ${own}. Joining now does not count for attendance.`,
        });
      }
    }

    let record = await Attendance.findOne({
      userId,
      date: { $in: legacyDateVariants(date) },
      stage: { $in: stageVariants(stage) },
      language,
    });

    if (record) {
      // Re-joining while a segment is still open (app was killed): close it first
      closeSegment(record, now);
      record.joinTime = now;
      record.lastActiveTime = now;
      record.userMode = "online";
      if (!record.firstJoinAt) record.firstJoinAt = now;
      if (!record.arrivalStatus || record.arrivalStatus === "Absent") {
        record.arrivalStatus = evaluateArrival(user, now, batchTime);
      }
      record.status = deriveOnlineStatus(record.totalMinutesSpent || 0, record.arrivalStatus);
      await record.save();
    } else {
      const arrival = evaluateArrival(user, now, batchTime);
      record = await Attendance.create({
        userId,
        userName: user.name,
        userPhone: user.phone,
        userMode: "online",
        language,
        stage,
        date,
        batchTime: batchTime || "Live Stream",
        firstJoinAt: now,
        joinTime: now,
        lastActiveTime: now,
        secondsSpent: 0,
        totalMinutesSpent: 0,
        arrivalStatus: arrival,
        status: deriveOnlineStatus(0, arrival),
      });
    }

    res.status(200).json({
      message: "Join time recorded/updated",
      attendanceId: record._id,
      status: record.status,
      totalMinutes: record.totalMinutesSpent,
    });
  } catch (error) {
    console.error("Join Online Class Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const loadOwnRecord = async (req, res) => {
  const { attendanceId } = req.body;
  if (!isValidId(attendanceId)) {
    res.status(400).json({ message: "Attendance ID required" });
    return null;
  }
  const record = await Attendance.findById(attendanceId);
  if (!record) {
    res.status(404).json({ message: "Record not found" });
    return null;
  }
  if (req.user && !isStaff(req.user) && String(record.userId) !== String(req.user._id)) {
    res.status(403).json({ message: "Forbidden" });
    return null;
  }
  return record;
};

const syncOnlineClass = async (req, res) => {
  try {
    const record = await loadOwnRecord(req, res);
    if (!record) return;

    const now = new Date();
    if (record.joinTime) {
      closeSegment(record, now);
      record.joinTime = now; // keep the session open from this checkpoint
      record.status = deriveOnlineStatus(record.totalMinutesSpent, record.arrivalStatus || record.status);
      await record.save();
    }

    res.status(200).json({ minutesSpent: record.totalMinutesSpent, status: record.status });
  } catch (error) {
    console.error("Sync Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const leaveOnlineClass = async (req, res) => {
  try {
    const record = await loadOwnRecord(req, res);
    if (!record) return;

    const now = new Date();
    if (record.joinTime) {
      closeSegment(record, now);
      record.joinTime = null;
      record.leaveTime = now;
      record.status = deriveOnlineStatus(record.totalMinutesSpent, record.arrivalStatus || record.status);
      await record.save();
    }

    res.status(200).json({ message: "Session ended", minutesSpent: record.totalMinutesSpent });
  } catch (error) {
    console.error("Leave Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// ADMIN: ATTENDANCE SHEET
// GET /api/admin/attendance?date=&stage=&language=&mode=&batchTime=&role=student|teacher|all
//
// No more writes on read: students without a record are returned as
// "Absent" rows built in memory (nothing is inserted into the database).
// =====================================================
const getAttendanceSheet = async (req, res) => {
  try {
    const date = normalizeDateKey(req.query.date) || dateKey();
    const stage = isAll(req.query.stage) ? null : normStage(req.query.stage);
    const language = isAll(req.query.language) ? null : normLanguage(req.query.language);
    const mode = isAll(req.query.mode) ? null : normMode(req.query.mode);
    // Batch filter = the student's chosen timing (works for online "Live Stream" records too)
    const batchTime = isAll(req.query.batchTime) ? null : normBatch(req.query.batchTime);
    if (!isAll(req.query.batchTime) && !batchTime) return res.status(200).json([]);
    const roleParam = String(req.query.role || "all").toLowerCase();

    const roles =
      roleParam === "student" ? ["student"] : roleParam === "teacher" ? STAFF_ROLES : ["student", ...STAFF_ROLES];

    // An unknown language like "Club" simply returns nothing (same as before)
    if (!isAll(req.query.language) && !language) return res.status(200).json([]);

    const recordQuery = { date: { $in: legacyDateVariants(date) } };
    if (stage) recordQuery.stage = { $in: stageVariants(stage) };
    if (language) recordQuery.language = language;
    if (mode) recordQuery.userMode = mode;

    const records = await Attendance.find(recordQuery).lean();

    const userIds = [...new Set(records.map((r) => String(r.userId)))];
    const users = await User.find({ _id: { $in: userIds }, role: { $in: roles } })
      .select("name phone mode role batchTime englishBatch hindiBatch")
      .lean();
    const userMap = new Map(users.map((u) => [String(u._id), u]));

    // The timing this student attends for the record's stage (each stage can have its own)
    const timingFor = (r, u) =>
      u.role === "student" ? stageBatch(u, r.language, normStage(r.stage)) || normBatch(r.batchTime) || "" : "";
    const inBatch = (r, u) => !batchTime || timingFor(r, u) === batchTime || normBatch(r.batchTime) === batchTime;

    // One row per user+stage+language (removes legacy duplicates)
    const best = new Map();
    for (const r of records) {
      const u = userMap.get(String(r.userId));
      if (!u || !inBatch(r, u)) continue;
      const key = `${r.userId}|${normStage(r.stage)}|${r.language}`;
      best.set(
        key,
        pickBest(best.get(key), {
          ...r,
          userName: u.name,
          userPhone: u.phone,
          stage: normStage(r.stage),
          studentBatch: timingFor(r, u), // the timing the student attends for this stage
        })
      );
    }

    const now = new Date();
    const results = [...best.values()].map((r) => {
      if (r.userMode === "online" && r.joinTime) {
        const mins = liveMinutes(r, now);
        return { ...r, totalMinutesSpent: mins, status: deriveOnlineStatus(mins, r.arrivalStatus || r.status) };
      }
      return r;
    });

    // Students with no record → in-memory "Absent" rows
    if (roles.includes("student")) {
      const attended = new Set(results.map((r) => String(r.userId)));
      const { end } = istDayRange(date);

      const studentQuery = { role: "student", createdAt: { $lte: end } };
      if (mode) studentQuery.mode = mode;

      const accessFields = language ? [language === "Hindi" ? "hindiAccess" : "englishAccess"] : ["englishAccess", "hindiAccess"];
      const stageKeys = stage ? [stage] : ["stage1", "stage2", "stage3", "stage4", "stage5", "stage6", "stage7"];
      studentQuery.$or = accessFields.flatMap((f) => stageKeys.map((s) => ({ [`${f}.${s}`]: true })));

      const students = await User.find(studentQuery)
        .select("name phone mode batchTime englishBatch hindiBatch englishAccess hindiAccess")
        .lean();

      for (const s of students) {
        if (attended.has(String(s._id))) continue;

        // Which of this student's enabled stages match the filters → their timing
        const matching = enabledStageTimings(s).filter(
          (t) => (!language || t.language === language) && (!stage || t.stage === stage)
        );
        const hit = batchTime ? matching.find((t) => t.batch === batchTime) : matching[0];
        if (!hit) continue;

        const lang = hit.language;
        results.push({
          _id: `absent-${s._id}`,
          synthetic: true,
          userId: s._id,
          userName: s.name,
          userPhone: s.phone,
          userMode: s.mode,
          language: lang,
          stage: stage || "all",
          date,
          batchTime: hit.batch || "N/A",
          studentBatch: hit.batch || "",
          status: "Absent",
          totalMinutesSpent: 0,
        });
      }
    }

    // 🚫 Joined a different batch today (not counted as attendance)
    const visitQuery = { date };
    if (language) visitQuery.language = language;
    if (stage) visitQuery.stage = stage;
    const visits = await BatchVisit.find(visitQuery).select("userId joinedBatch").lean();
    const visitByUser = new Map(visits.map((v) => [String(v.userId), v.joinedBatch]));
    for (const r of results) r.otherBatchJoin = visitByUser.get(String(r.userId)) || "";

    // 🎤 Speaking practice done in the live class today (marked by the trainer)
    const practice = await practiceIndex({ date, language, stage });
    for (const r of results) {
      const p =
        practice.get(`${r.userId}|${normStage(r.stage)}|${r.language}`) ||
        (r.synthetic ? practice.get(String(r.userId)) : null);
      r.practiced = !!p;
      r.practicedAt = p ? p.practicedAt : null;
      r.practiceTrainer = p ? p.trainerName || "" : "";
    }

    res.status(200).json(results);
  } catch (error) {
    console.error("Get Attendance Sheet Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// OTHER-BATCH JOINS (admin + trainer)
// GET /api/admin/batch-visitors?date=&language=&stage=
// =====================================================
const getBatchVisitors = async (req, res) => {
  try {
    const date = normalizeDateKey(req.query.date) || dateKey();
    const query = { date };
    if (!isAll(req.query.language)) {
      const language = normLanguage(req.query.language);
      if (!language) return res.status(200).json({ date, total: 0, visitors: [] });
      query.language = language;
    }
    if (!isAll(req.query.stage)) {
      const stage = normStage(req.query.stage);
      if (stage) query.stage = stage;
    }
    const visitors = await BatchVisit.find(query).sort({ lastJoinedAt: -1 }).lean();
    res.status(200).json({ date, total: visitors.length, visitors });
  } catch (error) {
    console.error("Batch Visitors Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const getAllStudentsFiltered = async (req, res) => {
  try {
    const students = await User.find({ role: "student" }).select("-password -sessionToken").lean();
    res.status(200).json({ total: students.length, students });
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// TRAINER: CLASSROOM ROSTER
// GET /api/admin/trainer-roster?stage=&language=&section=&date=&mode=
// =====================================================
const getTrainerClassroomRoster = async (req, res) => {
  try {
    const stage = normStage(req.query.stage) || "stage1";
    const language = normLanguage(req.query.language) || "English";
    const isHindi = language === "Hindi";
    const mode = isAll(req.query.mode) ? null : normMode(req.query.mode);
    const date = normalizeDateKey(req.query.date) || dateKey();

    const studentQuery = { role: "student" };
    studentQuery[`${isHindi ? "hindiAccess" : "englishAccess"}.${stage}`] = true;

    // Hindi classes are not split by mode or section (same behaviour as before)
    if (mode && !isHindi) studentQuery.mode = mode;

    const rawSection = String(req.query.section || "").trim();
    if (!isHindi && rawSection && !["none", "all"].includes(rawSection.toLowerCase())) {
      const host = normSection(rawSection);
      const merges = await SectionMerge.find({ language, stage, hostSection: host, isActive: true }).lean();
      studentQuery.onlineSection = { $in: [host, ...merges.map((m) => String(m.guestSection).toUpperCase())] };
    }

    const batch = isAll(req.query.batchTime) ? null : normBatch(req.query.batchTime);

    const { end } = istDayRange(date);
    studentQuery.createdAt = { $lte: end };

    const [students, records, practice] = await Promise.all([
      User.find(studentQuery).select("-password -sessionToken").lean(),
      Attendance.find({
        date: { $in: legacyDateVariants(date) },
        stage: { $in: stageVariants(stage) },
        language,
      }).lean(),
      practiceIndex({ date, language, stage }),
    ]);

    const recordByUser = new Map();
    for (const r of records) {
      const k = String(r.userId);
      recordByUser.set(k, pickBest(recordByUser.get(k), r));
    }

    const now = new Date();
    const roster = students
      // batchTime = the student's timing for THIS stage (Stage 1 at 5:30 AM, Stage 2 at 3:30 PM, ...)
      .map((s) => ({ ...s, defaultBatchTime: s.batchTime || "", batchTime: stageBatch(s, language, stage) }))
      .filter((s) => !batch || s.batchTime === batch)
      .map((student) => {
      const record = recordByUser.get(String(student._id));
      const p = practice.get(`${student._id}|${stage}|${language}`);
      const practiceInfo = { practiced: !!p, practicedAt: p ? p.practicedAt : null };
      if (!record) {
        return { ...student, ...practiceInfo, attendanceStatus: "Absent", totalMinutesSpent: 0, markedAt: null };
      }

      const isOnline = record.userMode === "online";
      const mins = isOnline ? liveMinutes(record, now) : record.totalMinutesSpent || 0;
      const status = isOnline ? deriveOnlineStatus(mins, record.arrivalStatus || record.status) : record.status;

      return {
        ...student,
        ...practiceInfo,
        attendanceStatus: status,
        totalMinutesSpent: mins,
        markedAt: record.markedAt || record.firstJoinAt || record.joinTime || null,
      };
    });

    res.status(200).json({ total: roster.length, students: roster });
  } catch (error) {
    console.error("Trainer Classroom Roster Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// STUDENT: MY ATTENDANCE
// =====================================================
const getMyAttendance = async (req, res) => {
  try {
    // Students see only their own log; staff (admin panel) may pass ?userId= to view a student
    const userId = req.user && !(isStaff(req.user) && req.query.userId) ? String(req.user._id) : req.query.userId;
    if (!isValidId(userId)) return res.status(400).json({ message: "Valid userId required" });

    const [records, practiceRows] = await Promise.all([
      Attendance.find({ userId }).sort({ createdAt: -1 }).limit(400).lean(),
      Practice.find({ userId }).select("date language stage practicedAt").lean(),
    ]);
    // 🎤 Which classes the student did speaking practice in
    const practiced = new Map(practiceRows.map((p) => [`${p.date}|${p.language}|${p.stage}`, p.practicedAt]));

    const now = new Date();
    const out = records.map((r) => {
      const row = r.userMode === "online" && r.joinTime ? { ...r, totalMinutesSpent: liveMinutes(r, now) } : { ...r };
      const key = `${normalizeDateKey(r.date) || r.date}|${r.language}|${normStage(r.stage)}`;
      row.practiced = practiced.has(key);
      row.practicedAt = practiced.get(key) || null;
      return row;
    });
    res.status(200).json({ total: out.length, records: out });
  } catch (error) {
    console.error("Get My Attendance Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// CRON (20:15 IST, after the last batch ends at 20:00)
// Closes open online sessions and writes ONE "Absent" record for every
// active student / trainer with no record today. Bulk — 2 queries + 1 write.
// =====================================================
const autoMarkAbsent = async (req, res) => {
  try {
    const now = new Date();
    const date = dateKey(now);
    const dates = legacyDateVariants(date);

    // 1. Close sessions left open (app killed, network lost)
    const open = await Attendance.find({ date: { $in: dates }, joinTime: { $ne: null } });
    for (const r of open) {
      closeSegment(r, new Date(Math.min(now, new Date(r.lastActiveTime || r.joinTime).getTime() + 5 * 60000)));
      r.joinTime = null;
      r.leaveTime = r.lastActiveTime;
      r.status = deriveOnlineStatus(r.totalMinutesSpent, r.arrivalStatus || r.status);
      await r.save();
    }

    // 2. Absent rows for everyone with nothing today
    const withRecord = await Attendance.distinct("userId", { date: { $in: dates } });
    const seen = new Set(withRecord.map(String));

    const anyAccess = ["englishAccess", "hindiAccess"].flatMap((f) =>
      [1, 2, 3, 4, 5, 6, 7].map((n) => ({ [`${f}.stage${n}`]: true }))
    );
    const users = await User.find({
      $or: [{ role: { $in: STAFF_ROLES } }, { role: "student", $or: anyAccess }],
    })
      .select("name phone mode language role teacherStage batchTime englishBatch hindiBatch englishAccess hindiAccess")
      .lean();

    const highestStage = (map) => {
      for (let n = 7; n >= 1; n--) if (map && map[`stage${n}`]) return `stage${n}`;
      return null;
    };

    const ops = [];
    for (const u of users) {
      if (seen.has(String(u._id))) continue;

      let stage = normStage(u.teacherStage) || "stage1";
      let language = u.language || "English";
      if (u.role === "student") {
        const eng = highestStage(u.englishAccess);
        const hin = highestStage(u.hindiAccess);
        language = eng ? "English" : "Hindi";
        stage = eng || hin || "stage1";
      }

      ops.push({
        updateOne: {
          filter: { userId: u._id, date, stage, language },
          update: {
            $setOnInsert: {
              userId: u._id,
              userName: u.name,
              userPhone: u.phone,
              userMode: u.mode || "offline",
              language,
              stage,
              date,
              batchTime: (u.role === "student" && stageBatch(u, language, stage)) || "N/A",
              status: "Absent",
              arrivalStatus: "Absent",
              totalMinutesSpent: 0,
              secondsSpent: 0,
            },
          },
          upsert: true,
        },
      });
    }

    if (ops.length) await Attendance.bulkWrite(ops, { ordered: false });

    const message = `Closed ${open.length} open sessions, marked ${ops.length} absent.`;
    console.log(`✅ Auto-absent ${date}: ${message}`);
    if (res) res.status(200).json({ message });
  } catch (error) {
    console.error("Auto Absent Error:", error);
    if (res) res.status(500).json({ message: "Server Error" });
  }
};

module.exports = {
  markAttendance,
  joinOnlineClass,
  syncOnlineClass,
  leaveOnlineClass,
  getAttendanceSheet,
  getAllStudentsFiltered,
  getTrainerClassroomRoster,
  getMyAttendance,
  getBatchVisitors,
  autoMarkAbsent,
  // exported for tests
  _internal: { evaluateStudentBatchStatus, evaluateTeacherStatus, deriveOnlineStatus, closeSegment, haversineMeters },
};
