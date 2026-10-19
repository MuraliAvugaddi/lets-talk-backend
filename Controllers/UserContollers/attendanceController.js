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
const { BATCHES, normBatch, stageBatch, enabledStageTimings, inBatchWindow, batchAt } = require("../../utils/batches");
const BatchVisit = require("../../Models/batchVisit");
const { practiceIndex } = require("./practiceController");
const Practice = require("../../Models/practice");
const { getModes, assemblyArrival } = require("../../utils/classMode");
const { holidayFor, loadHolidays, holidayApplies, publicHoliday } = require("../../utils/holidays");
const rules = require("../../utils/attendanceRules");

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

// ⏰ Time rules (student 7-minute grace, trainer 05:25–05:27 / 02:55–02:57) → utils/attendanceRules.js

// =====================================================
// HELPERS
// =====================================================
const isStaff = (user) => !!user && STAFF_ROLES.includes(user.role);

// With a token we trust ONLY the token. Without one (transition mode) we fall back to the body.
const actingUserId = (req) => (req.user ? String(req.user._id) : req.body.userId || req.query.userId);

// Trainer: on time = by 3 min before the shift (05:27 AM / 02:57 PM)
const evaluateTeacherStatus = (when) => rules.trainerArrival(istMinutesOfDay(when)).status;

// Student: on time = by 7 min after the class starts (05:37 AM for the 05:30 class)
const evaluateStudentBatchStatus = (when, batchTimeStr) =>
  rules.studentArrival(istMinutesOfDay(when), batchTimeStr || DEFAULT_BATCH).status;

/** { status, lateByMinutes } for this person arriving now */
const arrivalInfo = (user, when, batchTime) => {
  const mins = istMinutesOfDay(when);
  if (isStaff(user)) {
    const a = rules.trainerArrival(mins);
    return { status: a.status, lateByMinutes: a.lateByMinutes };
  }
  const a = rules.studentArrival(mins, batchTime || DEFAULT_BATCH);
  return { status: a.status, lateByMinutes: a.lateByMinutes };
};

// Trainers have two attendances a day: the record key carries the shift label
const shiftFieldsFor = (user, when) => {
  if (!isStaff(user)) return null;
  const a = rules.trainerArrival(istMinutesOfDay(when));
  return { shift: a.shift, batchTime: a.shiftLabel };
};

// ---- online sessions (join → leave) shown to the admin ----
const openSession = (record, now) => {
  if (!Array.isArray(record.sessions)) record.sessions = [];
  const last = record.sessions[record.sessions.length - 1];
  if (last && !last.out) last.out = record.lastActiveTime || now; // app was killed → close at last activity
  record.sessions.push({ in: now, out: null });
  if (record.sessions.length > 40) record.sessions = record.sessions.slice(-40);
};
const closeSession = (record, when) => {
  const list = record.sessions || [];
  const last = list[list.length - 1];
  if (last && !last.out) last.out = when;
};

// Which batch a check-in belongs to: what the app sent, else the student's timing for THIS stage
const resolveBatch = (user, sentBatch, language, stage) =>
  normBatch(sentBatch) || (user && user.role === "student" ? stageBatch(user, language, stage) || null : null);

const evaluateArrival = (user, when, batchTime) =>
  isStaff(user) ? evaluateTeacherStatus(when) : evaluateStudentBatchStatus(when, batchTime);

// Online final status: stayed 45+ min → their arrival verdict (Present, or Late if they came late)
const deriveOnlineStatus = (minutes, arrivalStatus) => {
  if (minutes >= PRESENT_MINUTES) return arrivalStatus === "Late" ? "Late" : "Present";
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

    // Trainers: morning + afternoon = two check-ins a day
    const shiftInfo = shiftFieldsFor(user, now);

    const existing = await Attendance.findOne({
      userId,
      date: { $in: legacyDateVariants(date) },
      stage: { $in: stageVariants(stage) },
      language,
      markedAt: { $exists: true, $ne: null },
      ...(shiftInfo ? { batchTime: shiftInfo.batchTime } : {}),
    }).lean();

    if (existing) {
      return res.status(200).json({
        message: `Already marked as ${existing.status}${shiftInfo ? ` (${shiftInfo.batchTime})` : ""}`,
        record: existing,
      });
    }

    const batchTime = shiftInfo ? shiftInfo.batchTime : resolveBatch(user, req.body.batchTime, language, stage) || DEFAULT_BATCH;
    const { status, lateByMinutes } = arrivalInfo(user, now, batchTime);

    const record = await Attendance.findOneAndUpdate(
      shiftInfo ? { userId, stage, date, language, batchTime } : { userId, stage, date, language },
      {
        $set: {
          userName: user.name,
          userPhone: user.phone,
          userMode: user.mode || "offline",
          batchTime,
          status,
          arrivalStatus: status,
          lateByMinutes,
          shift: shiftInfo ? shiftInfo.shift : "",
          markedAt: now,
          location: { lat, lng },
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    );

    const lateText = lateByMinutes ? ` — ${lateByMinutes} min late` : "";
    res.status(200).json({
      message: `${shiftInfo ? `${shiftInfo.batchTime}: ` : ""}Marked as ${status}${lateText}`,
      record,
      lateByMinutes,
    });
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

    const modes = await getModes();

    // 🎙 PRINCIPAL CLASS: one join marks attendance for EVERY stage the student has
    if (modes.assembly && (req.body.assembly === true || req.body.assembly === "true")) {
      return joinAssembly(req, res, user, modes.assembly, { language, stage, now, date });
    }

    // 🌧 Rain day: an offline student / trainer attending online
    const rainDay = !!(modes.rain && user.mode === "offline");

    // 🔁 Student joined a DIFFERENT timing (e.g. timing 03:30 PM but works then,
    // so joins the 09:00 AM class). Attendance COUNTS, but the record says
    // "joined another timing" so admin + trainer can see it.
    let otherBatch = false;
    let joinedBatch = "";
    let arrivalBatch = batchTime;
    if (user.role === "student" && process.env.ENFORCE_BATCH_WINDOW !== "false") {
      const own = stageBatch(user, language, stage);
      const mins = istMinutesOfDay(now);
      if (own && !inBatchWindow(own, mins)) {
        const running = batchAt(mins);
        otherBatch = true;
        joinedBatch = running ? running.label : "Outside class hours";
        if (running) arrivalBatch = running.label; // on time / late is judged for the class they joined
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
      } else if (own) {
        joinedBatch = own;
      }
    }

    // Trainers: morning + afternoon shift are two separate attendances
    const shiftInfo = shiftFieldsFor(user, now);

    let record = await Attendance.findOne({
      userId,
      date: { $in: legacyDateVariants(date) },
      stage: { $in: stageVariants(stage) },
      language,
      ...(shiftInfo ? { batchTime: shiftInfo.batchTime } : {}),
    });

    if (record) {
      // Re-joining while a segment is still open (app was killed): close it first
      closeSegment(record, now);
      openSession(record, now);
      record.joinTime = now;
      record.lastActiveTime = now;
      record.userMode = user.mode === "offline" ? "offline" : "online";
      if (rainDay) record.classMode = "rain";
      if (!record.firstJoinAt) record.firstJoinAt = now;
      if (!record.arrivalStatus || record.arrivalStatus === "Absent") {
        const a = arrivalInfo(user, now, arrivalBatch);
        record.arrivalStatus = a.status;
        record.lateByMinutes = a.lateByMinutes;
      }
      // Joining their OWN class later the same day clears the "other timing" mark
      if (!otherBatch && joinedBatch) {
        record.otherBatch = false;
        record.joinedBatch = joinedBatch;
      } else if (otherBatch && (record.otherBatch || !record.joinedBatch)) {
        record.otherBatch = true;
        record.joinedBatch = joinedBatch;
      }
      record.status = deriveOnlineStatus(record.totalMinutesSpent || 0, record.arrivalStatus);
      await record.save();
    } else {
      const a = arrivalInfo(user, now, arrivalBatch);
      const arrival = a.status;
      record = await Attendance.create({
        lateByMinutes: a.lateByMinutes,
        shift: shiftInfo ? shiftInfo.shift : "",
        sessions: [{ in: now, out: null }],
        otherBatch,
        joinedBatch,
        userId,
        userName: user.name,
        userPhone: user.phone,
        userMode: user.mode === "offline" ? "offline" : "online",
        classMode: rainDay ? "rain" : "",
        language,
        stage,
        date,
        batchTime: shiftInfo ? shiftInfo.batchTime : batchTime || "Live Stream",
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
      message: otherBatch
        ? `Attendance marked. You joined the ${joinedBatch} class (your timing is ${stageBatch(user, language, stage)}).`
        : "Join time recorded/updated",
      attendanceId: record._id,
      status: record.status,
      arrivalStatus: record.arrivalStatus,
      lateByMinutes: record.lateByMinutes || 0,
      shift: record.shift || "",
      totalMinutes: record.totalMinutesSpent,
      outsideBatch: otherBatch,
      otherBatch,
      ownBatch: user.role === "student" ? stageBatch(user, language, stage) : "",
      joinedBatch,
    });
  } catch (error) {
    console.error("Join Online Class Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// The stages one person attends: student → every enabled stage, trainer → their own stage
const assemblyStagesOf = (user, fallback) => {
  if (user.role !== "student") {
    return [{ language: normLanguage(user.language) || fallback.language, stage: normStage(user.teacherStage) || fallback.stage }];
  }
  const list = enabledStageTimings(user).map((t) => ({ language: t.language, stage: t.stage, batch: t.batch }));
  return list.length ? list : [{ language: fallback.language, stage: fallback.stage }];
};

const joinAssembly = async (req, res, user, assembly, { language, stage, now, date }) => {
  const arrival = assemblyArrival(assembly, istMinutesOfDay(now));
  const userId = String(user._id);
  const records = [];
  for (const s of assemblyStagesOf(user, { language, stage })) {
    let record = await Attendance.findOne({
      userId,
      date: { $in: legacyDateVariants(date) },
      stage: { $in: stageVariants(s.stage) },
      language: s.language,
    });
    if (record) {
      closeSegment(record, now);
      openSession(record, now);
      record.joinTime = now;
      record.lastActiveTime = now;
      record.classMode = "assembly";
      if (!record.firstJoinAt) record.firstJoinAt = now;
      if (!record.arrivalStatus || record.arrivalStatus === "Absent") record.arrivalStatus = arrival;
      record.joinedBatch = `${assembly.title || "Special class"} ${assembly.startTime}`;
      record.otherBatch = false;
      record.status = deriveOnlineStatus(record.totalMinutesSpent || 0, record.arrivalStatus);
      await record.save();
    } else {
      record = await Attendance.create({
        userId,
        userName: user.name,
        userPhone: user.phone,
        userMode: user.mode === "offline" ? "offline" : "online",
        classMode: "assembly",
        language: s.language,
        stage: s.stage,
        date,
        batchTime: s.batch || `${assembly.title || "Special class"} ${assembly.startTime}`,
        joinedBatch: `${assembly.title || "Special class"} ${assembly.startTime}`,
        sessions: [{ in: now, out: null }],
        firstJoinAt: now,
        joinTime: now,
        lastActiveTime: now,
        secondsSpent: 0,
        totalMinutesSpent: 0,
        arrivalStatus: arrival,
        status: deriveOnlineStatus(0, arrival),
      });
    }
    records.push(record);
  }
  if (req.io) req.io.to("admin_room").emit("attendance_update", { type: "assembly", userId });
  const first = records[0];
  return res.status(200).json({
    message: `Special class attendance marked for ${records.length} class${records.length === 1 ? "" : "es"}`,
    attendanceId: first._id,
    attendanceIds: records.map((r) => r._id),
    status: first.status,
    totalMinutes: first.totalMinutesSpent,
    assembly: true,
  });
};

// Principal class: sync / leave applies to ALL of the person's records of today
const updateAssemblySiblings = async (record, now, leaving) => {
  if (record.classMode !== "assembly") return;
  const siblings = await Attendance.find({
    userId: record.userId,
    date: record.date,
    classMode: "assembly",
    _id: { $ne: record._id },
  });
  for (const r of siblings) {
    if (!r.joinTime) continue;
    closeSegment(r, now);
    r.joinTime = leaving ? null : now;
    if (leaving) {
      r.leaveTime = now;
      closeSession(r, now);
    }
    r.status = deriveOnlineStatus(r.totalMinutesSpent, r.arrivalStatus || r.status);
    await r.save();
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
    await updateAssemblySiblings(record, now, false);

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
      closeSession(record, now);
      record.joinTime = null;
      record.leaveTime = now;
      record.status = deriveOnlineStatus(record.totalMinutesSpent, record.arrivalStatus || record.status);
      await record.save();
    }
    await updateAssemblySiblings(record, now, true);

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

    const [records, holidayStudents, holidayTrainers] = await Promise.all([
      Attendance.find(recordQuery).lean(),
      holidayFor(date, "student"),
      holidayFor(date, "teacher"),
    ]);

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
      // trainers have two attendances a day (morning / afternoon) → one row per shift
      const shift = u.role === "student" ? "" : rules.shiftOfRecord(r);
      const key = `${r.userId}|${normStage(r.stage)}|${r.language}|${shift}`;
      best.set(
        key,
        pickBest(best.get(key), {
          ...r,
          role: u.role,
          shift,
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
          status: holidayStudents ? "Holiday" : "Absent",
          holiday: holidayStudents ? holidayStudents.title || "Holiday" : "",
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

    // ⏱️ When they joined / checked in, still in class now?, when they left
    for (const r of results) {
      // 🏖 holiday: an auto-"Absent" (never came) is shown as Holiday
      const hol = r.role && r.role !== "student" ? holidayTrainers : holidayStudents;
      const neverCame = !r.firstJoinAt && !r.markedAt && !r.joinTime;
      if (hol && r.status === "Absent" && neverCame) {
        r.status = "Holiday";
        r.holiday = hol.title || "Holiday";
      }
      r.lateByMinutes = r.lateByMinutes || 0;
      r.sessions = (r.sessions || []).map((x) => ({ in: x.in, out: x.out || (r.joinTime ? null : r.leaveTime || r.lastActiveTime || null) }));
      if (!r.sessions.length && r.firstJoinAt) {
        r.sessions = [{ in: r.firstJoinAt, out: r.joinTime ? null : r.leaveTime || r.lastActiveTime || null }];
      }
      r.joinedAt = r.firstJoinAt || r.markedAt || r.joinTime || null;
      r.inClassNow = !!r.joinTime;
      r.classMode = r.classMode || "";
      r.leftAt = r.joinTime ? null : r.leaveTime || r.lastActiveTime || null;
    }

    // 🎤 Speaking practice done in the live class today (marked by the trainer)
    const practice = await practiceIndex({ date, language, stage });
    for (const r of results) {
      const p =
        practice.get(`${r.userId}|${normStage(r.stage)}|${r.language}`) ||
        (r.synthetic ? practice.get(String(r.userId)) : null);
      r.practiced = !!p;
      r.practicedAt = p ? p.practicedAt : null;
      r.practiceTrainer = p ? p.trainerName || "" : "";
      r.practiceRating = p && p.rating ? p.rating : 0;
      r.practiceNote = p ? p.note || "" : "";
    }

    res.status(200).json(results);
  } catch (error) {
    console.error("Get Attendance Sheet Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// 👩‍🏫 TRAINER ATTENDANCE — two attendances a day (admin)
// GET /api/admin/trainer-attendance?date=&mode=&language=&stage=
// Every trainer with: morning { status, joinedAt, lateByMinutes, minutes, sessions },
//                     afternoon { … }, holiday, overall status.
// =====================================================
const getTrainerAttendance = async (req, res) => {
  try {
    const date = normalizeDateKey(req.query.date) || dateKey();
    const mode = isAll(req.query.mode) ? null : normMode(req.query.mode);
    const language = isAll(req.query.language) ? null : normLanguage(req.query.language);
    const stage = isAll(req.query.stage) ? null : normStage(req.query.stage);

    const teacherQuery = { role: { $in: STAFF_ROLES } };
    if (mode) teacherQuery.mode = mode;
    if (language) teacherQuery.language = language;
    if (stage) teacherQuery.teacherStage = { $regex: `^stage\\s*${stage.replace("stage", "")}$`, $options: "i" };

    const [trainers, holiday] = await Promise.all([
      User.find(teacherQuery).select("name phone mode language role teacherStage teacherSection").lean(),
      holidayFor(date, "teacher"),
    ]);
    const ids = trainers.map((t) => t._id);
    const records = ids.length
      ? await Attendance.find({ userId: { $in: ids }, date: { $in: legacyDateVariants(date) } }).lean()
      : [];

    const now = new Date();
    const todayKey = dateKey(now);
    const nowMins = istMinutesOfDay(now);

    const shiftView = (recs, shiftKey) => {
      const shift = rules.shiftByKey(shiftKey);
      const mine = recs.filter((r) => rules.shiftOfRecord(r) === shiftKey);
      const attended = mine.filter((r) => r.firstJoinAt || r.markedAt || r.joinTime);
      if (!attended.length) {
        // not yet time for this shift today → "Upcoming", otherwise Absent / Holiday
        const upcoming = date === todayKey && nowMins < shift.start + 15;
        return {
          shift: shiftKey,
          label: shift.label,
          status: holiday ? "Holiday" : upcoming ? "Upcoming" : "Absent",
          start: rules.fmtClock(shift.start),
        };
      }
      // earliest arrival of this shift (a trainer may have records on two stages)
      attended.sort((a, b) => new Date(a.firstJoinAt || a.markedAt || a.joinTime) - new Date(b.firstJoinAt || b.markedAt || b.joinTime));
      const r = attended[0];
      const online = !r.markedAt;
      const minutes = attended.reduce((t, x) => t + (x.joinTime ? liveMinutes(x, now) : x.totalMinutesSpent || 0), 0);
      const status = r.arrivalStatus && r.arrivalStatus !== "Absent" ? r.arrivalStatus : r.status;
      return {
        shift: shiftKey,
        label: shift.label,
        start: rules.fmtClock(shift.start),
        status: status === "Partial" ? "Present" : status, // trainers: on time or late
        joinedAt: r.firstJoinAt || r.markedAt || r.joinTime,
        leftAt: r.joinTime ? null : r.leaveTime || r.lastActiveTime || null,
        inClassNow: attended.some((x) => !!x.joinTime),
        lateByMinutes: r.lateByMinutes || 0,
        isGps: !online,
        minutes: online ? minutes : 0,
        sessions: (r.sessions || []).map((x) => ({ in: x.in, out: x.out || null })),
        stage: normStage(r.stage),
      };
    };

    const rank = { Late: 3, Present: 2, Upcoming: 1, Holiday: 1, Absent: 0 };
    const out = trainers.map((t) => {
      const recs = records.filter((r) => String(r.userId) === String(t._id));
      const morning = shiftView(recs, "morning");
      const afternoon = shiftView(recs, "afternoon");
      const states = [morning.status, afternoon.status];
      const came = states.filter((x) => x === "Present" || x === "Late").length;
      let status = "Absent";
      if (states.includes("Late")) status = "Late";
      else if (states.includes("Present")) status = "Present";
      else if (holiday) status = "Holiday";
      else if (states.every((x) => x === "Upcoming")) status = "Upcoming";
      return {
        _id: t._id,
        name: t.name,
        phone: t.phone,
        mode: t.mode,
        language: t.language,
        role: t.role,
        stage: normStage(t.teacherStage) || t.teacherStage || "",
        section: t.teacherSection || "",
        morning,
        afternoon,
        shiftsAttended: came,
        lateMinutes: (morning.lateByMinutes || 0) + (afternoon.lateByMinutes || 0),
        status,
      };
    });
    out.sort((a, b) => (rank[b.status] ?? 0) - (rank[a.status] ?? 0) || String(a.name).localeCompare(String(b.name)));

    const totals = { total: out.length, present: 0, late: 0, absent: 0, holiday: 0, shiftsAttended: 0, shiftsLate: 0 };
    for (const t of out) {
      if (t.status === "Present") totals.present++;
      else if (t.status === "Late") totals.late++;
      else if (t.status === "Holiday") totals.holiday++;
      else if (t.status === "Absent") totals.absent++;
      totals.shiftsAttended += t.shiftsAttended;
      totals.shiftsLate += [t.morning, t.afternoon].filter((x) => x.status === "Late").length;
    }

    res.set("Cache-Control", "no-store");
    res.status(200).json({
      date,
      holiday: publicHoliday(holiday),
      rules: rules.rulesSummary(),
      totals,
      trainers: out,
    });
  } catch (error) {
    console.error("Trainer Attendance Error:", error);
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
    // Trainer view: only students of THIS trainer's section (+ sections merged into it today)
    const rawSection = String(req.query.section || "").trim();
    if (query.language === "English" && rawSection && !["none", "all"].includes(rawSection.toLowerCase())) {
      const host = normSection(rawSection);
      const merges = query.stage
        ? await SectionMerge.find({ language: "English", stage: query.stage, hostSection: host, isActive: true }).lean()
        : [];
      query.section = { $in: [host, ...merges.map((m) => String(m.guestSection).toUpperCase())] };
    }
    const visitors = await BatchVisit.find(query).sort({ lastJoinedAt: -1 }).lean();
    res.status(200).json({ date, total: visitors.length, visitors });
  } catch (error) {
    console.error("Batch Visitors Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// BATCH-WISE SUMMARY (admin + trainer)
// GET /api/admin/batch-summary?date=&language=&stage=&section=&mode=
// For each of the 7 timings: how many students, who came on time / late /
// partial / absent, who came FROM another timing, and who of this timing
// attended ANOTHER timing instead (still counted as attended).
// =====================================================
const summarizeBatches = ({ students, records, language, stage, now = new Date() }) => {
  const recByKey = new Map();
  for (const r of records) {
    const key = `${r.userId}|${normStage(r.stage)}|${r.language}`;
    recByKey.set(key, pickBest(recByKey.get(key), r));
  }

  const buckets = new Map();
  const bucket = (label) => {
    const k = label || "none";
    if (!buckets.has(k)) {
      buckets.set(k, {
        batch: label || "",
        total: 0,
        attended: 0,
        present: [],
        late: [],
        partial: [],
        absent: [],
        fromOther: [], // came to THIS timing from their own other timing
        elsewhere: [], // belong to this timing but attended another one
      });
    }
    return buckets.get(k);
  };
  for (const b of BATCHES) bucket(b.label);

  for (const s of students) {
    for (const t of enabledStageTimings(s)) {
      if (language && t.language !== language) continue;
      if (stage && t.stage !== stage) continue;
      const own = t.batch || "";
      const ownB = bucket(own);
      ownB.total++;

      const r = recByKey.get(`${s._id}|${t.stage}|${t.language}`);
      const person = {
        userId: s._id,
        name: s.name,
        phone: s.phone,
        stage: t.stage,
        language: t.language,
        section: s.onlineSection || "",
        ownBatch: own,
      };
      if (!r || r.status === "Absent") {
        ownB.absent.push(person);
        continue;
      }
      const isOnline = r.userMode === "online";
      const mins = isOnline ? liveMinutes(r, now) : r.totalMinutesSpent || 0;
      const status = isOnline ? deriveOnlineStatus(mins, r.arrivalStatus || r.status) : r.status;
      const joined = normBatch(r.joinedBatch) || (r.otherBatch ? r.joinedBatch || "" : own);
      const row = {
        ...person,
        status,
        minutes: mins,
        joinedBatch: joined,
        joinedAt: r.firstJoinAt || r.markedAt || r.joinTime || null,
      };
      if (status === "Absent") {
        ownB.absent.push(person);
        continue;
      }
      ownB.attended++;
      if (r.otherBatch && joined !== own) {
        ownB.elsewhere.push(row);
        if (normBatch(joined)) bucket(joined).fromOther.push(row);
        continue;
      }
      if (status === "Present") ownB.present.push(row);
      else if (status === "Late") ownB.late.push(row);
      else ownB.partial.push(row);
    }
  }

  const order = [...BATCHES.map((b) => b.label), "none"];
  return order
    .map((k) => buckets.get(k))
    .filter((b) => b && (b.batch || b.total > 0))
    .map((b) => ({
      ...b,
      counts: {
        total: b.total,
        attended: b.attended,
        present: b.present.length,
        late: b.late.length,
        partial: b.partial.length,
        absent: b.absent.length,
        fromOther: b.fromOther.length,
        elsewhere: b.elsewhere.length,
      },
    }));
};

const getBatchSummary = async (req, res) => {
  try {
    const date = normalizeDateKey(req.query.date) || dateKey();
    const language = isAll(req.query.language) ? null : normLanguage(req.query.language);
    const stage = isAll(req.query.stage) ? null : normStage(req.query.stage);
    const mode = isAll(req.query.mode) ? null : normMode(req.query.mode);
    const { end } = istDayRange(date);

    const studentQuery = { role: "student", createdAt: { $lte: end } };
    if (mode && language !== "Hindi") studentQuery.mode = mode;
    const accessFields = language ? [language === "Hindi" ? "hindiAccess" : "englishAccess"] : ["englishAccess", "hindiAccess"];
    const stageKeys = stage ? [stage] : ["stage1", "stage2", "stage3", "stage4", "stage5", "stage6", "stage7"];
    studentQuery.$or = accessFields.flatMap((f) => stageKeys.map((k) => ({ [`${f}.${k}`]: true })));

    // Trainer view: own section (+ sections merged into it today)
    const rawSection = String(req.query.section || "").trim();
    if (language === "English" && stage && rawSection && !["none", "all"].includes(rawSection.toLowerCase())) {
      const host = normSection(rawSection);
      const merges = await SectionMerge.find({ language, stage, hostSection: host, isActive: true }).lean();
      studentQuery.onlineSection = { $in: [host, ...merges.map((m) => String(m.guestSection).toUpperCase())] };
    }

    const recordQuery = { date: { $in: legacyDateVariants(date) } };
    if (stage) recordQuery.stage = { $in: stageVariants(stage) };
    if (language) recordQuery.language = language;

    const [students, records] = await Promise.all([
      User.find(studentQuery)
        .select("name phone mode onlineSection batchTime englishBatch hindiBatch englishAccess hindiAccess")
        .lean(),
      Attendance.find(recordQuery).lean(),
    ]);

    const batches = summarizeBatches({ students, records, language, stage });
    const totals = batches.reduce(
      (t, b) => {
        for (const k of Object.keys(t)) t[k] += b.counts[k];
        return t;
      },
      { total: 0, attended: 0, present: 0, late: 0, partial: 0, absent: 0, fromOther: 0, elsewhere: 0 }
    );
    const holiday = await holidayFor(date, "student");
    res.status(200).json({ date, language: language || "all", stage: stage || "all", totals, batches, holiday: publicHoliday(holiday) });
  } catch (error) {
    console.error("Batch Summary Error:", error);
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
    let hostSection = "";
    let guestSections = [];
    let mergedInto = null;
    if (!isHindi && rawSection && !["none", "all"].includes(rawSection.toLowerCase())) {
      const host = normSection(rawSection);
      hostSection = host;
      const [merges, mine] = await Promise.all([
        SectionMerge.find({ language, stage, hostSection: host, isActive: true }).lean(),
        SectionMerge.findOne({ language, stage, guestSection: host, isActive: true }).lean(),
      ]);
      guestSections = merges.map((m) => String(m.guestSection).toUpperCase());
      if (mine) mergedInto = { id: String(mine._id), hostSection: mine.hostSection };
      studentQuery.onlineSection = { $in: [host, ...guestSections] };
    }

    const batch = isAll(req.query.batchTime) ? null : normBatch(req.query.batchTime);

    const { end } = istDayRange(date);
    studentQuery.createdAt = { $lte: end };

    const holidayStudents = await holidayFor(date, "student");
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
      const own = String(student.onlineSection || "").toUpperCase();
      const practiceInfo = {
        mergedFrom: hostSection && own && own !== hostSection ? own : "", // "B" = joined from Section B today
        practiced: !!p,
        practicedAt: p ? p.practicedAt : null,
        practiceRating: p && p.rating ? p.rating : 0,
      };
      if (!record || (holidayStudents && record.status === "Absent" && !record.firstJoinAt && !record.markedAt)) {
        return {
          ...student,
          ...practiceInfo,
          attendanceStatus: holidayStudents ? "Holiday" : "Absent",
          totalMinutesSpent: 0,
          markedAt: null,
        };
      }

      // rain day / principal class: an offline student's record counts online minutes too
      const isOnline = record.userMode === "online" || !!record.classMode;
      const mins = isOnline ? liveMinutes(record, now) : record.totalMinutesSpent || 0;
      const status = isOnline ? deriveOnlineStatus(mins, record.arrivalStatus || record.status) : record.status;

      return {
        ...student,
        ...practiceInfo,
        attendanceStatus: status,
        totalMinutesSpent: mins,
        lateByMinutes: record.lateByMinutes || 0,
        markedAt: record.markedAt || record.firstJoinAt || record.joinTime || null,
        inClassNow: !!record.joinTime,
        otherBatch: !!record.otherBatch,
        joinedBatch: record.joinedBatch || "",
        classMode: record.classMode || "",
      };
    });

    res.status(200).json({
      total: roster.length,
      students: roster,
      merge: { hostSection, guestSections, mergedInto }, // 🔀 today's section merge for this trainer
      holiday: publicHoliday(holidayStudents), // 🏖 today is a holiday
    });
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
      const until = new Date(Math.min(now, new Date(r.lastActiveTime || r.joinTime).getTime() + 5 * 60000));
      closeSegment(r, until);
      closeSession(r, r.lastActiveTime || until);
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

    // 🏖 Holiday today → nobody (of that group) is marked absent
    const holidayStudents = await holidayFor(date, "student");
    const holidayTrainers = await holidayFor(date, "teacher");

    const ops = [];
    let skippedHoliday = 0;
    for (const u of users) {
      if (seen.has(String(u._id))) continue;
      if (u.role === "student" ? holidayStudents : holidayTrainers) {
        skippedHoliday++;
        continue;
      }

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

    const message = `Closed ${open.length} open sessions, marked ${ops.length} absent${skippedHoliday ? `, ${skippedHoliday} on holiday` : ""}.`;
    console.log(`✅ Auto-absent ${date}: ${message}`);
    if (res) res.status(200).json({ message });
  } catch (error) {
    console.error("Auto Absent Error:", error);
    if (res) res.status(500).json({ message: "Server Error" });
  }
};

module.exports = {
  _assembly: { assemblyStagesOf },
  markAttendance,
  joinOnlineClass,
  syncOnlineClass,
  leaveOnlineClass,
  getAttendanceSheet,
  getAllStudentsFiltered,
  getTrainerClassroomRoster,
  getMyAttendance,
  getBatchVisitors,
  getBatchSummary,
  getTrainerAttendance,
  autoMarkAbsent,
  // exported for tests
  _internal: { summarizeBatches, evaluateStudentBatchStatus, evaluateTeacherStatus, deriveOnlineStatus, closeSegment, haversineMeters, openSession, closeSession, arrivalInfo },
};
