const Attendance = require("../../Models/attendance");
const User = require("../../Models/users");

const getFormattedDate = (d = new Date()) =>
  `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}`;

const evaluateAttendanceStatus = (joinDate, batchStartTimeStr = "05:30") => {
  if (!joinDate) return "Absent";
  const join = new Date(joinDate);
  const [hours, minutes] = batchStartTimeStr.split(":").map(Number);
  const batchStart = new Date(join);
  batchStart.setHours(hours, minutes, 0, 0);
  const diffMinutes = Math.round((join - batchStart) / 60000);

  if (diffMinutes <= 5 && diffMinutes >= -30) {
    return "Present";
  } else if (diffMinutes > 5 && diffMinutes <= 45) {
    return "Late";
  } else {
    return "Present";
  }
};

const markAttendance = async (req, res) => {
  try {
    const { userId, stage, lat, lng, language, batchTime } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const now = new Date();
    const dateStr = getFormattedDate(now);
    const status = evaluateAttendanceStatus(now, "05:30");

    const record = await Attendance.findOneAndUpdate(
      { userId, stage: stage || user.teacherStage || "Stage 1", date: dateStr },
      {
        userName: user.name,
        userPhone: user.phone,
        userMode: user.mode || "offline",
        language: language || user.language || "English",
        batchTime: batchTime || "05:30 - 07:00",
        status: status,
        markedAt: now,
        location: { lat, lng },
      },
      { upsert: true, new: true }
    );
    res.status(200).json({ message: `Marked as ${status}`, record });
  } catch (error) {
    console.error("Mark Attendance Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const joinOnlineClass = async (req, res) => {
  try {
    const { userId, language, stage, joinTime, batchStartTime } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const now = joinTime ? new Date(joinTime) : new Date();
    const dateStr = getFormattedDate(now);
    const userStage = stage || user.teacherStage || "Stage 1";
    const evaluatedStatus = evaluateAttendanceStatus(now, batchStartTime || "05:30");

    let record = await Attendance.findOne({ userId, stage: userStage, date: dateStr });

    if (record) {
      record.joinTime = now;
      record.lastActiveTime = now;
      if (record.status === "Absent") record.status = evaluatedStatus;
      await record.save();
    } else {
      record = await Attendance.create({
        userId,
        userName: user.name,
        userPhone: user.phone,
        userMode: "online",
        language: language || user.language || "English",
        stage: userStage,
        date: dateStr,
        joinTime: now,
        lastActiveTime: now,
        totalMinutesSpent: user.role === 'teacher' || user.role === 'admin' ? 60 : 0,
        status: evaluatedStatus,
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

const syncOnlineClass = async (req, res) => {
  try {
    const { attendanceId, returnTime } = req.body;
    if (!attendanceId) return res.status(400).json({ message: "Attendance ID required" });

    const record = await Attendance.findById(attendanceId);
    if (!record) return res.status(404).json({ message: "Record not found" });

    const start = new Date(record.joinTime || record.createdAt);
    const end = returnTime ? new Date(returnTime) : new Date();
    const elapsedMinutes = Math.max(0, Math.round((end - start) / 60000));

    record.totalMinutesSpent = Math.min((record.totalMinutesSpent || 0) + elapsedMinutes, 90);
    record.lastActiveTime = end;
    await record.save();

    res.status(200).json({ minutesSpent: record.totalMinutesSpent, status: record.status });
  } catch (error) {
    console.error("Sync Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const leaveOnlineClass = async (req, res) => {
  try {
    const { attendanceId, leaveTime } = req.body;
    if (!attendanceId) return res.status(400).json({ message: "Attendance ID required" });

    const record = await Attendance.findById(attendanceId);
    if (!record) return res.status(404).json({ message: "Record not found" });

    if (record.joinTime) {
      const start = new Date(record.joinTime);
      const end = leaveTime ? new Date(leaveTime) : new Date();
      const sessionMinutes = Math.max(0, Math.round((end - start) / 60000));
      record.totalMinutesSpent = Math.min((record.totalMinutesSpent || 0) + sessionMinutes, 90);
      record.lastActiveTime = end;
      record.joinTime = null;
    }
    await record.save();

    res.status(200).json({ message: "Session ended", minutesSpent: record.totalMinutesSpent });
  } catch (error) {
    console.error("Leave Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const getAttendanceSheet = async (req, res) => {
  try {
    const { date } = req.query;
    let attendanceQuery = {};
    if (date) attendanceQuery.date = date;
    const attendances = await Attendance.find(attendanceQuery).lean();
    res.status(200).json(attendances || []);
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
};

const getAllStudentsFiltered = async (req, res) => {
  try {
    const students = await User.find({ role: "student" }).select("-password").lean();
    res.status(200).json({ total: students.length, students });
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
};

const getAllTeachersFiltered = async (req, res) => {
  try {
    const teachers = await User.find({ role: { $in: ["teacher", "admin"] } }).select("-password").lean();
    res.status(200).json({ total: teachers.length, teachers });
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 🚀 STRICT TRAINER ROSTER FILTER (MODE, SECTION & EXACT STAGE MATCHING) ---
const getTrainerClassroomRoster = async (req, res) => {
  try {
    const { stage, language, section, date, mode } = req.query;
    
    let studentQuery = { role: "student" };
    
    // 1. Language Filter
    if (language && language.toLowerCase() !== "all") {
      studentQuery.language = { $regex: new RegExp(`^${language}$`, "i") };
    }
    
    // 2. Mode Filter (Online vs Offline enforcement)
    if (mode && mode.toLowerCase() !== "all") {
      studentQuery.mode = { $regex: new RegExp(`^${mode}$`, "i") };
    }

    // 3. Strict Section Filter (Only if online, or match section)
    if (section && section.toLowerCase() !== "none" && section.toLowerCase() !== "all") {
      const cleanSec = section.trim().toUpperCase();
      studentQuery.onlineSection = { $regex: new RegExp(`^${cleanSec}$`, "i") };
    }

    // 4. Precise Stage Key Normalization
    let rawStage = stage ? stage.toString().toLowerCase().replace(/\s+/g, "") : "stage1";
    let stageNumber = rawStage.replace(/[^0-9]/g, "");
    if (!stageNumber) stageNumber = "1";
    const stageKey = `stage${stageNumber}`; // e.g. "stage1" or "stage7"

    const langKey = (language && language.toLowerCase() === "hindi") ? "hindiAccess" : "englishAccess";
    
    // Enforce that this exact stage boolean MUST be true
    studentQuery[`${langKey}.${stageKey}`] = true;

    const students = await User.find(studentQuery).select("-password").lean();
    const dateStr = date || getFormattedDate(new Date());
    const attendanceRecords = await Attendance.find({ date: dateStr }).lean();

    const roster = students.map((student) => {
      const record = attendanceRecords.find(
        (att) => att.userId.toString() === student._id.toString()
      );

      let currentMins = record ? record.totalMinutesSpent : 0;
      if (record && record.userMode === "online" && record.joinTime) {
        const diff = Math.round((new Date() - new Date(record.joinTime)) / 60000);
        currentMins = Math.min((record.totalMinutesSpent || 0) + Math.max(0, diff), 90);
      }

      const evaluatedStatus = currentMins >= 45 ? "Present" : (currentMins >= 15 ? "Partial" : (record ? record.status : "Absent"));

      return {
        ...student,
        attendanceStatus: record ? evaluatedStatus : "Absent",
        totalMinutesSpent: currentMins,
        markedAt: record ? record.markedAt || record.joinTime : null,
      };
    });

    res.status(200).json({
      total: roster.length,
      students: roster,
    });
  } catch (error) {
    console.error("Trainer Classroom Roster Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const getMyAttendance = async (req, res) => {
  try {
    const { userId } = req.query;
    const records = await Attendance.find({ userId }).sort({ createdAt: -1 });
    res.status(200).json({ total: records.length, records });
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
};

const autoMarkAbsent = async (req, res) => {
  try {
    const now = new Date();
    const dateStr = getFormattedDate(now);
    const allUsers = await User.find({});
    let count = 0;

    for (const user of allUsers) {
      const record = await Attendance.findOne({ userId: user._id, date: dateStr });
      if (!record) {
        await Attendance.create({
          userId: user._id,
          userName: user.name,
          userPhone: user.phone,
          userMode: user.mode || "offline",
          language: user.language || "English",
          date: dateStr,
          stage: user.teacherStage || "Stage 1",
          status: "Absent",
          totalMinutesSpent: 0,
        });
        count++;
      }
    }
    if (res) res.status(200).json({ message: `Marked ${count} absent.` });
  } catch (error) {
    console.error("Auto Absent Error:", error);
  }
};

module.exports = {
  markAttendance,
  joinOnlineClass,
  syncOnlineClass,
  leaveOnlineClass,
  getAttendanceSheet,
  getAllStudentsFiltered,
  getAllTeachersFiltered,
  getTrainerClassroomRoster,
  getMyAttendance,
  autoMarkAbsent,
};