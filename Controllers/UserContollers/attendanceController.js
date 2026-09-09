const Attendance = require("../../Models/attendance");
const User = require("../../Models/users");

const getFormattedDate = (d = new Date()) =>
  `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}`;

// --- 1. OFFLINE ATTENDANCE (Geofence) ---
const markAttendance = async (req, res) => {
  try {
    const { userId, stage, batchTime, lat, lng, language } = req.body;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (!user.mode || user.mode.toLowerCase() !== "offline") {
      return res
        .status(403)
        .json({ message: "Only Offline users can use location check-in." });
    }

    const now = new Date();
    const dateStr = getFormattedDate(now);

    const existing = await Attendance.findOne({
      userId,
      stage: stage || "General",
      batchTime: batchTime || "N/A",
      date: dateStr,
    });

    if (existing && existing.status !== "Absent") {
      return res
        .status(400)
        .json({ message: "Attendance already marked for this batch today." });
    }

    let status = "Present";
    if (batchTime) {
      try {
        const startTimeStr = batchTime.split(" - ")[0].trim();
        const [time, modifier] = startTimeStr.split(" ");
        let [hours, minutes] = time.split(":");

        let hr = parseInt(hours, 10);
        if (modifier === "PM" && hr < 12) hr += 12;
        if (modifier === "AM" && hr === 12) hr = 0;

        const batchStart = new Date();
        batchStart.setHours(hr, parseInt(minutes, 10), 0, 0);

        const diffMinutes = (now - batchStart) / 60000;
        if (diffMinutes > 15) {
          status = "Late";
        }
      } catch (err) {
        console.error("Time Parse Error:", err);
      }
    }

    const record = await Attendance.findOneAndUpdate(
      {
        userId,
        stage: stage || "General",
        batchTime: batchTime || "N/A",
        date: dateStr,
      },
      {
        userName: user.name,
        userPhone: user.phone,
        userMode: "offline",
        language: language || user.language || "English",
        status,
        markedAt: now,
        location: { lat, lng },
      },
      { upsert: true, new: true }
    );

    res.status(200).json({ message: `Marked as ${status}`, record });
  } catch (error) {
    if (error.code === 11000) {
      return res
        .status(400)
        .json({ message: "Attendance already marked today." });
    }
    console.error("Mark Attendance Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 2. ONLINE LIVE CLASS: RECORD JOIN OR RE-JOIN ---
const joinOnlineClass = async (req, res) => {
  try {
    const { userId, language, stage, batchTime, joinTime } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const now = joinTime ? new Date(joinTime) : new Date();
    const dateStr = getFormattedDate(now);

    let record = await Attendance.findOne({
      userId,
      stage: stage || "General",
      batchTime: batchTime || "N/A",
      date: dateStr,
    });

    if (record) {
      record.joinTime = now;
      record.lastActiveTime = now;
      if (record.status === "Absent") record.status = "Partial";
      await record.save();
    } else {
      record = await Attendance.create({
        userId,
        userName: user.name,
        userPhone: user.phone,
        userMode: "online",
        language: language || user.language || "English",
        stage: stage || "General",
        batchTime: batchTime || "N/A",
        date: dateStr,
        joinTime: now,
        lastActiveTime: now,
        totalMinutesSpent: 0,
        status: "Partial",
      });
    }

    res.status(200).json({
      message: "Join time recorded/updated",
      attendanceId: record._id,
      totalMinutes: record.totalMinutesSpent,
    });
  } catch (error) {
    console.error("Join Online Class Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 3. ONLINE LIVE CLASS: ACCURATE SYNC ON RETURN ---
const syncOnlineClass = async (req, res) => {
  try {
    const { attendanceId, returnTime } = req.body;
    if (!attendanceId) {
      return res.status(400).json({ message: "Attendance ID is required" });
    }

    const record = await Attendance.findById(attendanceId);
    if (!record) {
      return res.status(404).json({ message: "Session record not found" });
    }

    const start = new Date(record.joinTime || record.createdAt);
    const end = returnTime ? new Date(returnTime) : new Date();

    const elapsedMinutes = Math.max(0, Math.round((end - start) / 60000));
    const accumulatedMinutes = Math.min((record.totalMinutesSpent || 0) + elapsedMinutes, 90);

    record.totalMinutesSpent = accumulatedMinutes;
    record.lastActiveTime = end;

    if (record.totalMinutesSpent >= 45) {
      record.status = "Present";
    } else if (record.totalMinutesSpent >= 15) {
      record.status = "Partial";
    } else {
      record.status = "Absent";
    }

    await record.save();

    res.status(200).json({
      minutesSpent: record.totalMinutesSpent,
      status: record.status,
    });
  } catch (error) {
    console.error("Sync Online Class Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 4. ONLINE LIVE CLASS: EXPLICIT LEAVE SESSION ---
const leaveOnlineClass = async (req, res) => {
  try {
    const { attendanceId, leaveTime } = req.body;
    if (!attendanceId) {
      return res.status(400).json({ message: "Attendance ID is required" });
    }

    const record = await Attendance.findById(attendanceId);
    if (!record) {
      return res.status(404).json({ message: "Session record not found" });
    }

    if (record.joinTime) {
      const start = new Date(record.joinTime);
      const end = leaveTime ? new Date(leaveTime) : new Date();

      const sessionMinutes = Math.max(0, Math.round((end - start) / 60000));
      const accumulatedMinutes = Math.min((record.totalMinutesSpent || 0) + sessionMinutes, 90);

      record.totalMinutesSpent = accumulatedMinutes;
      record.lastActiveTime = end;
      record.joinTime = null; 
    }

    if (record.totalMinutesSpent >= 45) {
      record.status = "Present";
    } else if (record.totalMinutesSpent >= 15) {
      record.status = "Partial";
    } else {
      record.status = "Absent";
    }

    await record.save();

    res.status(200).json({
      message: "Session ended and minutes accumulated",
      minutesSpent: record.totalMinutesSpent,
      status: record.status,
    });
  } catch (error) {
    console.error("Leave Online Class Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 5. ADMIN: MASTER ATTENDANCE SHEET ---
const getAttendanceSheet = async (req, res) => {
  try {
    const { date, stage, batchTime, mode, language } = req.query;
    let attendanceQuery = {};

    if (date) {
      const parts = date.split("-");
      if (parts.length === 3) {
        const d = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);
        const y = parseInt(parts[2], 10);
        attendanceQuery.date = {
          $regex: new RegExp(`^0?${d}-0?${m}-${y}$`),
        };
      } else {
        attendanceQuery.date = date;
      }
    }

    if (stage && stage.toLowerCase() !== "all") {
      attendanceQuery.stage = {
        $regex: new RegExp(`^${stage.replace(/\s+/g, "\\s*")}$`, "i"),
      };
    }

    if (batchTime && batchTime.toLowerCase() !== "all") {
      attendanceQuery.batchTime = {
        $regex: new RegExp(`^${batchTime.replace(/\s+/g, "\\s*")}$`, "i"),
      };
    }

    if (mode && mode.toLowerCase() !== "all") {
      attendanceQuery.userMode = {
        $regex: new RegExp(`^${mode}$`, "i"),
      };
    }

    if (language && language.toLowerCase() !== "all") {
      attendanceQuery.language = {
        $regex: new RegExp(`^${language}$`, "i"),
      };
    }

    const attendances = await Attendance.find(attendanceQuery)
      .sort({ createdAt: -1 })
      .lean();

    if (!attendances || attendances.length === 0) {
      return res.status(200).json([]);
    }

    const formattedList = attendances.map((rec) => {
      let calcMinutes = rec.totalMinutesSpent || 0;
      
      if (rec.userMode === "online" && rec.joinTime) {
        const diff = Math.round((new Date() - new Date(rec.joinTime)) / 60000);
        calcMinutes = Math.min((rec.totalMinutesSpent || 0) + Math.max(0, diff), 90);
      }

      return {
        userId: rec.userId,
        userName: rec.userName || "Unknown",
        userPhone: rec.userPhone || "No Phone",
        userMode: rec.userMode || "offline",
        status: calcMinutes >= 45 ? "Present" : (calcMinutes >= 15 ? "Partial" : (rec.status || "Absent")),
        markedAt: rec.markedAt || rec.joinTime || null,
        totalMinutes: calcMinutes,
        batchTime: rec.batchTime || "N/A",
        stage: rec.stage || "General",
        language: rec.language || "English",
        date: rec.date,
      };
    });

    res.status(200).json(formattedList);
  } catch (error) {
    console.error("Get Master Attendance Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 6. ADMIN: GET ALL STUDENTS/STAFF DIRECTORY ---
const getAllStudentsFiltered = async (req, res) => {
  try {
    const { language, stage, mode } = req.query;
    let query = {};

    if (mode && mode.toLowerCase() !== "all") {
      query.mode = { $regex: new RegExp(`^${mode}$`, "i") };
    }

    if (
      language &&
      language.toLowerCase() !== "all" &&
      stage &&
      stage.toLowerCase() !== "all"
    ) {
      const stageKey = stage.toLowerCase().replace(/\s+/g, "");
      if (language.toLowerCase() === "english") {
        query[`englishAccess.${stageKey}`] = true;
      } else if (language.toLowerCase() === "hindi") {
        query[`hindiAccess.${stageKey}`] = true;
      }
    }

    const students = await User.find(query)
      .select("-password")
      .sort({ createdAt: -1 })
      .lean();

    const now = new Date();
    const dateStr = getFormattedDate(now);

    const enrichedStudents = await Promise.all(
      students.map(async (student) => {
        const attendance = await Attendance.findOne({
          userId: student._id,
          date: dateStr,
        }).sort({ updatedAt: -1 });

        let currentMins = attendance ? attendance.totalMinutesSpent : 0;
        if (attendance && attendance.userMode === "online" && attendance.joinTime) {
          const diff = Math.round((new Date() - new Date(attendance.joinTime)) / 60000);
          currentMins = Math.min((attendance.totalMinutesSpent || 0) + Math.max(0, diff), 90);
        }

        const evaluatedStatus = currentMins >= 45 ? "Present" : (currentMins >= 15 ? "Partial" : (attendance ? attendance.status : "Absent"));

        return {
          ...student,
          attendanceStatus: attendance ? evaluatedStatus : "Absent",
          totalMinutesSpent: currentMins,
          batchTime: attendance ? attendance.batchTime : "Not Joined",
          markedAt: attendance
            ? attendance.markedAt || attendance.joinTime
            : null,
        };
      })
    );

    res.status(200).json({
      total: enrichedStudents.length,
      students: enrichedStudents,
    });
  } catch (error) {
    console.error("Error fetching all students:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 7. USER: GET PERSONAL ATTENDANCE HISTORY ---
const getMyAttendance = async (req, res) => {
  try {
    const { userId, language } = req.query;
    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    let query = { userId };
    if (language && language.toLowerCase() !== "all") {
      query.language = language;
    }

    const records = await Attendance.find(query).sort({ createdAt: -1 });

    res.status(200).json({
      total: records.length,
      records,
    });
  } catch (error) {
    console.error("Get My Attendance Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 8. SYSTEM: AUTO-MARK ABSENT ---
const autoMarkAbsent = async (req, res) => {
  try {
    const now = new Date();
    const dateStr = getFormattedDate(now);

    const allUsers = await User.find({});
    let count = 0;

    for (const user of allUsers) {
      const record = await Attendance.findOne({
        userId: user._id,
        date: dateStr,
      });
      if (!record) {
        try {
          await Attendance.create({
            userId: user._id,
            userName: user.name,
            userPhone: user.phone,
            userMode: user.mode || "offline",
            language: user.language || "English",
            date: dateStr,
            stage: user.teacherStage || "Stage 1",
            batchTime: "N/A",
            status: "Absent",
            totalMinutesSpent: 0,
          });
          count++;
        } catch (innerError) {
          if (innerError.code !== 11000) console.error(innerError);
        }
      }
    }

    res.status(200).json({
      message: `Auto-Absent complete. Marked ${count} users absent.`,
    });
  } catch (error) {
    console.error("Auto Absent Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = {
  markAttendance,
  joinOnlineClass,
  syncOnlineClass,
  leaveOnlineClass,
  getAttendanceSheet,
  getAllStudentsFiltered,
  getMyAttendance,
  autoMarkAbsent,
};