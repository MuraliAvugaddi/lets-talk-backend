const User = require("../../Models/users");
const Attendance = require("../../Models/attendance");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// Generate JWT Token helper
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET || "fallback_secret", {
    expiresIn: "30d",
  });
};

// Helper to safely format online section to match allowed schema values
const sanitizeSection = (sec) => {
  if (!sec) return "None";
  const trimmed = sec.trim();
  const validSections = ["A", "B", "C", "D", "E", "None"];
  const matched = validSections.find(v => v.toLowerCase() === trimmed.toLowerCase());
  return matched || "None";
};

// --- 1. REGISTER USER ---
const registerUser = async (req, res) => {
  try {
    const { name, phone, password, mode, onlineSection, language, role, teacherStage, teacherSection } = req.body;

    if (!name || !phone || !password) {
      return res.status(400).json({ message: "Please provide name, phone, and password." });
    }

    const userExists = await User.findOne({ phone });
    if (userExists) {
      return res.status(400).json({ message: "User with this phone number already exists." });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = await User.create({
      name,
      phone,
      password: hashedPassword,
      mode: mode || "online",
      onlineSection: sanitizeSection(onlineSection || "A"),
      language: language || "English",
      role: role || "student",
      teacherStage: teacherStage || "stage1",
      teacherSection: teacherSection || "None",
      englishAccess: { stage1: true, stage2: false, stage3: false, stage4: false, stage5: false, stage6: false, stage7: false },
      hindiAccess: { stage1: false, stage2: false, stage3: false, stage4: false, stage5: false, stage6: false, stage7: false },
    });

    if (user) {
      res.status(201).json({
        success: true,
        token: generateToken(user._id),
        role: user.role,
        user: {
          _id: user._id,
          id: user._id,
          name: user.name,
          phone: user.phone,
          role: user.role,
          mode: user.mode,
          language: user.language,
          stage: user.teacherStage,
          section: user.teacherSection,
          onlineSection: user.onlineSection,
        },
      });
    } else {
      res.status(400).json({ message: "Invalid user data" });
    }
  } catch (error) {
    console.error("Register Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 2. LOGIN USER ---
const loginUser = async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ message: "Please provide phone and password" });
    }

    const user = await User.findOne({ phone });
    if (!user) {
      return res.status(401).json({ message: "Invalid phone number or password" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid phone number or password" });
    }

    res.status(200).json({
      success: true,
      token: generateToken(user._id),
      role: user.role || "student",
      user: {
        _id: user._id,
        id: user._id,
        name: user.name,
        phone: user.phone,
        role: user.role || "student",
        mode: user.mode || "offline",
        language: user.language || "English",
        stage: user.teacherStage || "stage1",
        section: user.teacherSection || "None",
        onlineSection: user.onlineSection || "None",
      },
    });
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 3. RESET PASSWORD ---
const resetPassword = async (req, res) => {
  try {
    const { phone, newPassword } = req.body;
    if (!phone || !newPassword) {
      return res.status(400).json({ message: "Phone and new password are required" });
    }

    const user = await User.findOne({ phone });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    res.status(200).json({ message: "Password reset successfully" });
  } catch (error) {
    console.error("Reset Password Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 4. GET USER PROFILE ---
const getUserProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("-password");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.status(200).json(user);
  } catch (error) {
    console.error("Get Profile Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 5. GET ALL USERS / STUDENTS ---
const getAllUsers = async (req, res) => {
  try {
    const { mode } = req.query;
    let query = {}; 

    if (mode && mode.toLowerCase() !== "all") {
      query.mode = { $regex: new RegExp(`^${mode}$`, "i") };
    }

    const students = await User.find(query).select("-password").lean();

    res.status(200).json({
      success: true,
      total: students.length,
      students: students,
    });
  } catch (error) {
    console.error("Get All Users Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 6. GET USERS BY STAGE ---
const getUsersByStage = async (req, res) => {
  try {
    const { stage } = req.query;
    let query = {};
    if (stage && stage.toLowerCase() !== "all") {
      const cleanStage = stage.replace(/\s+/g, "");
      query.teacherStage = { 
        $regex: new RegExp(`^${cleanStage}$`, "i") 
      };
    }

    const users = await User.find(query).select("-password").lean();
    res.status(200).json(users || []);
  } catch (error) {
    console.error("Get Users By Stage Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 7. UPDATE USER ACCESS ---
const updateUserAccess = async (req, res) => {
  try {
    const { userId, englishAccess, hindiAccess, mode, onlineSection } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (englishAccess) user.englishAccess = englishAccess;
    if (hindiAccess) user.hindiAccess = hindiAccess;
    if (mode) user.mode = mode;
    if (onlineSection) user.onlineSection = sanitizeSection(onlineSection);

    await user.save();

    res.status(200).json({ message: "User access updated successfully", user });
  } catch (error) {
    console.error("Update User Access Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 8. UPDATE STUDENT STATUS ---
const updateStudentStatus = async (req, res) => {
  try {
    const { userId, feeStatus, onlineSection, mode } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (feeStatus) user.feeStatus = feeStatus;
    if (onlineSection) user.onlineSection = sanitizeSection(onlineSection);
    if (mode) user.mode = mode;

    await user.save();

    res.status(200).json({ message: "Student status updated", user });
  } catch (error) {
    console.error("Update Student Status Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- 9. DELETE USER ---
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findByIdAndDelete(id);
    if (!user) return res.status(404).json({ message: "User not found" });

    res.status(200).json({ message: "User deleted successfully" });
  } catch (error) {
    console.error("Delete User Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = {
  registerUser,
  loginUser,
  resetPassword,
  getUserProfile,
  getAllUsers,
  getUsersByStage,
  updateUserAccess,
  updateStudentStatus,
  deleteUser,
};