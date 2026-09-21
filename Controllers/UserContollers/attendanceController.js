const Attendance = require("../../Models/attendance");
const User = require("../../Models/users");

const getFormattedDate = (d = new Date()) => {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
};

const parseTimeToMinutes = (timeStr) => {
  const [hours, minutes] = timeStr.split(":").map(Number);
  return hours * 60 + minutes;
};

const evaluateTeacherStatus = (joinDate) => {
  if (!joinDate) return "Absent";
  const d = new Date(joinDate);
  const currentMins = d.getHours() * 60 + d.getMinutes();

  const morningStart = parseTimeToMinutes("05:25");
  const morningEnd = parseTimeToMinutes("05:35");
  const eveningStart = parseTimeToMinutes("15:25"); 
  const eveningEnd = parseTimeToMinutes("15:35");   

  if ((currentMins >= morningStart && currentMins <= morningEnd) ||
      (currentMins >= eveningStart && currentMins <= eveningEnd)) {
    return "Present";
  }
  return "Late"; 
};

const evaluateStudentBatchStatus = (joinDate, batchTimeStr = "05:30 AM - 07:00 AM") => {
  if (!joinDate) return "Absent";
  const join = new Date(joinDate);
  const joinMins = join.getHours() * 60 + join.getMinutes();

  const startTimePart = batchTimeStr.split("-")[0].trim(); 
  const parts = startTimePart.split(" ");
  let [hours, minutes] = parts[0].split(":").map(Number);
  const modifier = parts[1]; 

  if (modifier === "PM" && hours < 12) hours += 12;
  if (modifier === "AM" && hours === 12) hours = 0;

  const batchStartMins = hours * 60 + minutes;
  const diffMinutes = joinMins - batchStartMins;

  if (diffMinutes >= 0 && diffMinutes <= 5) {
    return "Present";
  } else if (diffMinutes > 5) {
    return "Late";
  } else if (diffMinutes < 0 && diffMinutes >= -30) {
    return "Present"; 
  }
  return "Late";
};

const ensureDailyAttendanceRecords = async (targetDateStr, roleType = "teacher") => {
  try {
    const queryRole = roleType === "teacher" 
      ? { role: { $in: ["teacher", "manager", "admin"] } } 
      : { role: "student" };
      
    const users = await User.find(queryRole).select("_id name phone mode language teacherStage createdAt").lean();

    const parts = targetDateStr.split("-");
    if (parts.length !== 3) return;
    const targetDate = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
    targetDate.setHours(0, 0, 0, 0);

    const bulkOps = [];

    for (const user of users) {
      const userCreatedAt = new Date(user.createdAt || user._id.getTimestamp());
      userCreatedAt.setHours(0, 0, 0, 0);

      if (userCreatedAt > targetDate) {
        continue;
      }

      const stageVal = user.teacherStage || "Stage 1";

      bulkOps.push({
        updateOne: {
          filter: { userId: user._id, date: targetDateStr, stage: stageVal },
          update: {
            $setOnInsert: {
              userId: user._id,
              userName: user.name,
              userPhone: user.phone,
              userMode: user.mode || "offline",
              language: user.language || "English",
              stage: stageVal,
              date: targetDateStr,
              status: "Absent",
              totalMinutesSpent: 0,
            }
          },
          upsert: true
        }
      });
    }

    if (bulkOps.length > 0) {
      await Attendance.bulkWrite(bulkOps, { ordered: false });
    }
  } catch (e) {
    console.error("Error ensuring daily attendance records:", e);
  }
};

const markAttendance = async (req, res) => {
  try {
    const { userId, stage, lat, lng, language, batchTime } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const now = new Date();
    const dateStr = getFormattedDate(now);
    const targetStage = stage || user.teacherStage || "Stage 1";

    let status = "Present";
    if (user.role === "teacher" || user.role === "manager" || user.role === "admin") {
      status = evaluateTeacherStatus(now);
    } else {
      status = evaluateStudentBatchStatus(now, batchTime);
    }

    const record = await Attendance.findOneAndUpdate(
      { userId, stage: targetStage, date: dateStr },
      {
        userName: user.name,
        userPhone: user.phone,
        userMode: user.mode || "offline",
        language: language || user.language || "English",
        batchTime: batchTime || "05:30 AM - 07:00 AM",
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
    
    let evaluatedStatus = "Present";
    if (user.role === "teacher" || user.role === "manager" || user.role === "admin") {
      evaluatedStatus = evaluateTeacherStatus(now);
    } else {
      evaluatedStatus = evaluateStudentBatchStatus(now, batchStartTime || "05:30 AM - 07:00 AM");
    }

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
    const { date, stage, language, mode, batchTime } = req.query;
    const targetRole = "student";

    if (date) {
      await ensureDailyAttendanceRecords(date, targetRole);
    }

    let attendanceQuery = {};
    if (date) {
      const parts = date.split("-");
      if (parts.length === 3) {
        const d = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);
        const y = parts[2];
        
        const possibleFormats = [
          `${d}-${m}-${y}`,
          `${String(d).padStart(2, '0')}-${String(m).padStart(2, '0')}-${y}`,
          `${String(d).padStart(2, '0')}-${m}-${y}`,
          `${d}-${String(m).padStart(2, '0')}-${y}`
        ];

        attendanceQuery.date = { $in: possibleFormats };
      } else {
        attendanceQuery.date = date;
      }
    }

    if (stage && stage !== "all") {
      const cleanStage = stage.replace(/\s+/g, "").toLowerCase();
      attendanceQuery.stage = { $regex: new RegExp(`^${cleanStage}$`, "i") };
    }
    if (language && language !== "all") {
      attendanceQuery.language = { $regex: new RegExp(`^${language}$`, "i") };
    }
    if (mode && mode !== "all") {
      attendanceQuery.userMode = { $regex: new RegExp(`^${mode}$`, "i") };
    }
    if (batchTime && batchTime !== "all") {
      attendanceQuery.batchTime = batchTime;
    }

    const attendances = await Attendance.find(attendanceQuery).lean();
    const userIds = [...new Set(attendances.map(att => att.userId))];
    const users = await User.find({ _id: { $in: userIds }, role: "student" }).select("name phone createdAt mode").lean();
    const userMap = new Map(users.map(u => [u._id.toString(), u]));

    let targetDate = null;
    if (date) {
      const parts = date.split("-");
      if (parts.length === 3) {
        targetDate = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
        targetDate.setHours(0, 0, 0, 0);
      }
    }

    const results = [];
    for (const att of attendances) {
      const user = userMap.get(att.userId.toString());
      if (user) {
        if (targetDate) {
          const userCreatedAt = new Date(user.createdAt || att.userId.getTimestamp());
          userCreatedAt.setHours(0, 0, 0, 0);
          if (userCreatedAt > targetDate) {
            continue; 
          }
        }

        results.push({
          ...att,
          userName: user.name,
          userPhone: user.phone,
        });
      }
    }

    res.status(200).json(results);
  } catch (error) {
    console.error("Get Attendance Sheet Error:", error);
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
    const { mode, language, stage } = req.query;
    let query = { role: { $in: ["teacher", "manager", "admin"] } };

    if (mode && mode.toLowerCase() !== "all") {
      query.mode = mode.toLowerCase();
    }
    if (language && language.toLowerCase() !== "all") {
      query.language = language.charAt(0).toUpperCase() + language.slice(1).toLowerCase();
    }
    if (stage && stage.toLowerCase() !== "all") {
      const cleanStage = stage.replace(/\s+/g, "").toLowerCase(); 
      const spacedStage = stage.toLowerCase();                            
      query.$or = [
        { teacherStage: { $regex: new RegExp(`^${spacedStage}$`, "i") } },
        { teacherStage: { $regex: new RegExp(`^${cleanStage}$`, "i") } }
      ];
    }

    const teachers = await User.find(query).select("-password").lean();
    res.status(200).json({
      success: true,
      total: teachers.length,
      teachers: teachers,
    });
  } catch (error) {
    console.error("Get Teachers Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// 🚀 FIXED: Strictly matches attendance records for the specific teacher's stage & language
const getTrainerClassroomRoster = async (req, res) => {
  try {
    const { stage, language, section, date, mode } = req.query;
    let studentQuery = { role: "student" };
    
    if (mode && mode.toLowerCase() !== "all") {
      studentQuery.mode = { $regex: new RegExp(`^${mode}$`, "i") };
    }

    const isHindi = language && language.toLowerCase() === "hindi";
    if (!isHindi && section && section.toLowerCase() !== "none" && section.toLowerCase() !== "all") {
      const cleanSec = section.trim().toUpperCase();
      studentQuery.onlineSection = { $regex: new RegExp(`^${cleanSec}$`, "i") };
    }

    let rawStage = stage ? stage.toString().toLowerCase().replace(/\s+/g, "") : "stage1";
    let stageNumber = rawStage.replace(/[^0-9]/g, "");
    if (!stageNumber) stageNumber = "1";
    const stageKey = `stage${stageNumber}`;
    const formattedStageName = `Stage ${stageNumber}`;

    const langKey = isHindi ? "hindiAccess" : "englishAccess";
    studentQuery[`${langKey}.${stageKey}`] = true;

    const students = await User.find(studentQuery).select("-password").lean();

    let targetDateStr = date || getFormattedDate(new Date());
    let possibleFormats = [targetDateStr];

    const parts = targetDateStr.split("-");
    let targetDate = null;
    if (parts.length === 3) {
      const d = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      const y = parts[2];
      
      targetDate = new Date(parseInt(y), m - 1, d);
      targetDate.setHours(0, 0, 0, 0);

      possibleFormats = [
        `${d}-${m}-${y}`,
        `${String(d).padStart(2, '0')}-${String(m).padStart(2, '0')}-${y}`,
        `${String(d).padStart(2, '0')}-${m}-${y}`,
        `${d}-${String(d).padStart(2, '0')}-${y}`
      ];
    }

    // 🚀 Strict query filtering by stage and language
    const attendanceQuery = {
      date: { $in: possibleFormats },
      stage: { $regex: new RegExp(`^stage\\s*${stageNumber}$`, "i") },
    };
    if (language && language !== "all") {
      attendanceQuery.language = { $regex: new RegExp(`^${language}$`, "i") };
    }

    const attendanceRecords = await Attendance.find(attendanceQuery).lean();

    const filteredStudents = students.filter((student) => {
      if (targetDate) {
        const studentCreatedAt = new Date(student.createdAt || student._id.getTimestamp());
        studentCreatedAt.setHours(0, 0, 0, 0);
        if (studentCreatedAt > targetDate) {
          return false;
        }
      }
      return true;
    });

    const roster = filteredStudents.map((student) => {
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

    res.status(200).json({ total: roster.length, students: roster });
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
      const userStage = user.teacherStage || "Stage 1";
      const record = await Attendance.findOne({ userId: user._id, date: dateStr, stage: userStage });
      if (!record) {
        await Attendance.create({
          userId: user._id,
          userName: user.name,
          userPhone: user.phone,
          userMode: user.mode || "offline",
          language: user.language || "English",
          date: dateStr,
          stage: userStage,
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