const Attendance = require("../../Models/attendance");
const User = require("../../Models/users");

// Helper date string formatter: D-M-YYYY
const getFormattedDate = (d = new Date()) =>
  `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}`;

// --- 1. OFFLINE ATTENDANCE (Geofence + Late Check) ---
const markAttendance = async (req, res) => {
  try {
    const { userId, stage, batchTime, lat, lng } = req.body;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (!user.mode || user.mode.toLowerCase() !== "offline") {
      return res
        .status(403)
        .json({ message: "Only Offline students can use location check-in." });
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

// --- 2. ONLINE LIVE CLASS: RECORD JOIN (Upsert Safe) ---
const joinOnlineClass = async (req, res) => {
  try {
    const { userId, language, stage, batchTime } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const now = new Date();
    const dateStr = getFormattedDate(now);

    const record = await Attendance.findOneAndUpdate(
      {
        userId,
        stage: stage || "General",
        batchTime: batchTime || "N/A",
        date: dateStr,
      },
      {
        $setOnInsert: {
          userName: user.name,
          userPhone: user.phone,
          userMode: "online",
          language: language || "English",
          joinTime: now,
          totalMinutesSpent: 0,
          status: "Partial",
        },
        $set: {
          lastActiveTime: now,
        },
      },
      { upsert: true, new: true }
    );

    res.status(200).json({
      message: "Join time recorded",
      attendanceId: record._id,
      totalMinutes: record.totalMinutesSpent,
    });
  } catch (error) {
    console.error("Join Online Class Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 3. ONLINE LIVE CLASS: 60s HEARTBEAT ACCUMULATOR ---
const onlineClassHeartbeat = async (req, res) => {
  try {
    const { attendanceId } = req.body;
    if (!attendanceId)
      return res.status(400).json({ message: "Attendance ID required" });

    const record = await Attendance.findById(attendanceId);
    if (!record) return res.status(404).json({ message: "Session not found" });

    record.totalMinutesSpent += 1;
    record.lastActiveTime = new Date();

    // If attended >= 45 mins in a 90-min class, automatically upgrade to Present
    if (record.totalMinutesSpent >= 45) {
      record.status = "Present";
    } else if (record.totalMinutesSpent >= 15) {
      record.status = "Partial";
    }

    await record.save();
    res.status(200).json({
      minutesSpent: record.totalMinutesSpent,
      status: record.status,
    });
  } catch (error) {
    console.error("Heartbeat Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 4. ADMIN: GET FILTERED ATTENDANCE SHEET ---
const getAttendanceSheet = async (req, res) => {
  try {
    const { date, stage, batchTime, mode, language } = req.query;
    let query = {};

    if (date) query.date = date;
    if (stage) query.stage = stage;
    if (batchTime) query.batchTime = batchTime;
    if (mode && mode.toLowerCase() !== "all") query.userMode = mode.toLowerCase();
    if (language && language.toLowerCase() !== "all") query.language = language;

    const records = await Attendance.find(query).sort({ createdAt: -1 });
    res.json(records);
  } catch (error) {
    console.error("Get Attendance Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 5. ADMIN: GET ALL STUDENTS WITH MULTI-FILTER ---
// @desc    Get All Students with Live Today's Attendance & Time Spent
// @route   GET /api/admin/all-students
// @access  Public / Admin
const getAllStudentsFiltered = async (req, res) => {
  try {
    const { language, stage, mode } = req.query;
    let query = {};

    // 1. Filter by Mode (Online / Offline)
    if (mode && mode.toLowerCase() !== "all") {
      query.mode = { $regex: new RegExp(`^${mode}$`, "i") };
    }

    // 2. Filter by Language & Specific Stage
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

    // 3. Attach today's live attendance info to each student
    const enrichedStudents = await Promise.all(
      students.map(async (student) => {
        const attendance = await Attendance.findOne({
          userId: student._id,
          date: dateStr,
        }).sort({ updatedAt: -1 });

        return {
          ...student,
          attendanceStatus: attendance ? attendance.status : "Absent",
          totalMinutesSpent: attendance ? attendance.totalMinutesSpent : 0,
          batchTime: attendance ? attendance.batchTime : "Not Joined",
          markedAt: attendance ? attendance.markedAt || attendance.joinTime : null,
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

// --- 6. USER: GET PERSONAL ATTENDANCE HISTORY ---
// @desc    Get Student Personal Attendance History
// @route   GET /api/user/my-attendance
// @access  Public / Protected
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

// --- 7. SYSTEM: AUTO-MARK ABSENT ---
const autoMarkAbsent = async (req, res) => {
  try {
    const now = new Date();
    const dateStr = getFormattedDate(now);

    const offlineUsers = await User.find({ mode: { $regex: /^offline$/i } });
    let count = 0;

    for (const user of offlineUsers) {
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
            userMode: "offline",
            date: dateStr,
            stage: "General",
            batchTime: "N/A",
            status: "Absent",
            markedAt: now,
          });
          count++;
        } catch (innerError) {
          if (innerError.code !== 11000) console.error(innerError);
        }
      }
    }

    res.status(200).json({
      message: `Auto-Absent complete. Marked ${count} students absent.`,
    });
  } catch (error) {
    console.error("Auto Absent Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = {
  markAttendance,
  joinOnlineClass,
  onlineClassHeartbeat,
  getAttendanceSheet,
  getAllStudentsFiltered,
  getMyAttendance,
  autoMarkAbsent,
};