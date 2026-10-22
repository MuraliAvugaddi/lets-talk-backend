const bcrypt = require("bcryptjs");
const User = require("../../Models/users");
const FeeHistory = require("../../Models/feeHistory");
const { signToken, readBearer, resolveUser } = require("../../middleware/authMiddleware");
const { verifyPhoneIdToken, samePhone } = require("../../utils/firebaseAdmin"); // old app versions only
const { verifyOtpToken } = require("./otpController"); // 🔐 MSG91 OTP
const { monthKey } = require("../../utils/time");
const {
  BATCHES,
  STAGE_KEYS,
  normBatch,
  batchFieldFor,
  cleanBatchMap,
  emptyBatchMap,
  findBatchConflict,
} = require("../../utils/batches");
const {
  normStage,
  normLanguage,
  normMode,
  normSection,
  escapeRegex,
  isAll,
  isValidId,
  cleanAccessMap,
  emptyAccessMap,
  STAFF_ROLES,
  ADMIN_ROLES,
} = require("../../utils/normalize");

const PUBLIC_FIELDS = "-password -sessionToken";

const cleanPhone = (phone) => String(phone || "").replace(/\D/g, "").slice(-10);

// Old accounts may have the phone saved as typed ("+91...", "91...", "98765...")
const phoneCandidates = (raw) => {
  const last10 = cleanPhone(raw);
  return [...new Set([String(raw || "").trim(), last10, `+91${last10}`, `91${last10}`])].filter(Boolean);
};

const toPublicUser = (user) => ({
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
  batchTime: user.batchTime || "",
  englishBatch: user.englishBatch,
  hindiBatch: user.hindiBatch,
  englishAccess: user.englishAccess,
  hindiAccess: user.hindiAccess,
  feeStatus: user.feeStatus,
});

// Only admins should see "student_update" events, not all 2,000 phones
const notifyAdmins = (req, event, payload) => {
  if (req.io) req.io.to("admin_room").emit(event, payload);
};

// =====================================================
// MONTHLY FEE ARCHIVE & RESET (cron, 1st of month 00:00 IST)
// =====================================================
const resetMonthlyFeesForNewMonth = async () => {
  try {
    const prevMonthYear = monthKey(new Date(), -1);

    const [totalStudents, totalPaid] = await Promise.all([
      User.countDocuments({ role: "student" }),
      User.countDocuments({ role: "student", feeStatus: "paid" }),
    ]);

    await FeeHistory.findOneAndUpdate(
      { monthYear: prevMonthYear },
      { totalStudents, totalPaid, totalUnpaid: totalStudents - totalPaid, archivedAt: new Date() },
      { upsert: true, returnDocument: "after" }
    );

    const result = await User.updateMany(
      { role: "student" },
      { $set: { feeStatus: "unpaid", feePaymentStatus: "not_submitted", feePaymentScreenshot: "" } }
    );

    console.log(`✅ Monthly fee reset (${prevMonthYear} archived): ${result.modifiedCount} students set to unpaid.`);
  } catch (err) {
    console.error("❌ Error running monthly fee reset cron:", err);
  }
};

// =====================================================
// REGISTER
// Students sign up themselves. Staff accounts (teacher/manager/admin)
// can ONLY be created by a logged-in admin/manager.
// =====================================================
const registerUser = async (req, res) => {
  try {
    const { name, password, mode, onlineSection, language, role, teacherStage, teacherSection, batchTime } = req.body;
    const phone = cleanPhone(req.body.phone);

    if (!name || !String(name).trim() || phone.length !== 10 || !password) {
      return res.status(400).json({ message: "Please provide name, a 10-digit phone number, and password." });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters." });
    }

    const requestedRole = STAFF_ROLES.includes(role) ? role : "student";

    // 🔐 Students prove the phone number with the MSG91 OTP (otpToken from /api/otp/verify).
    // OTP_SIGNUP_REQUIRED=true on Render once the new app is in the stores
    // (until then, old app versions without an otpToken can still sign up).
    if (requestedRole === "student") {
      if (req.body.otpToken) {
        try {
          const verified = verifyOtpToken(req.body.otpToken, "signup");
          if (verified !== phone) {
            return res.status(403).json({ message: "This phone number was not verified. Please verify the OTP again." });
          }
        } catch (e) {
          return res.status(401).json({ message: "OTP verification expired. Please verify your phone again." });
        }
      } else if (process.env.OTP_SIGNUP_REQUIRED === "true") {
        return res.status(401).json({ message: "Please verify your phone number with the OTP. Update the app if you don't see it." });
      }
    }

    if (requestedRole !== "student") {
      const token = readBearer(req);
      const { user: creator } = token ? await resolveUser(token) : {};
      if (!creator || !ADMIN_ROLES.includes(creator.role)) {
        return res.status(403).json({ message: "Only an admin or manager can create staff accounts." });
      }
      if (requestedRole === "admin" && creator.role !== "admin") {
        return res.status(403).json({ message: "Only an admin can create another admin." });
      }
    }

    const userExists = await User.findOne({ phone: { $in: phoneCandidates(req.body.phone) } }).select("_id").lean();
    if (userExists) {
      return res.status(400).json({ message: "User with this phone number already exists." });
    }

    const hashedPassword = await bcrypt.hash(String(password), 10);

    const user = await User.create({
      name: String(name).trim(),
      phone,
      password: hashedPassword,
      mode: normMode(mode) || "online",
      onlineSection: normSection(onlineSection || "A"),
      language: normLanguage(language) || "English",
      role: requestedRole,
      teacherStage: normStage(teacherStage) || "stage1",
      teacherSection: requestedRole === "student" ? "None" : normSection(teacherSection),
      batchTime: requestedRole === "student" ? normBatch(batchTime) || "" : "",
      englishAccess: emptyAccessMap(),
      hindiAccess: emptyAccessMap(),
      englishBatch: emptyBatchMap(),
      hindiBatch: emptyBatchMap(),
      feeStatus: "unpaid",
    });

    notifyAdmins(req, "student_update", { userId: String(user._id), by: req.user && String(req.user._id) === String(user._id) ? "student" : "admin", user: toPublicUser(user) });
    notifyAdmins(req, "new_user_registered", { userId: user._id });

    res.status(201).json({
      success: true,
      token: signToken(user),
      role: user.role,
      user: toPublicUser(user),
    });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(400).json({ message: "User with this phone number already exists." });
    }
    console.error("Register Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// LOGIN
// =====================================================
const loginUser = async (req, res) => {
  try {
    const phone = cleanPhone(req.body.phone);
    const { password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ message: "Please provide phone and password" });
    }

    const user = await User.findOne({ phone: { $in: phoneCandidates(req.body.phone) } });
    const ok = user && (await bcrypt.compare(String(password), user.password));
    if (!ok) {
      return res.status(401).json({ message: "Invalid phone number or password" });
    }

    res.status(200).json({
      success: true,
      token: signToken(user),
      role: user.role || "student",
      user: toPublicUser(user),
    });
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// RESET PASSWORD — requires the Firebase OTP ID token.
// Body: { phone, newPassword, idToken }
// =====================================================
const resetPassword = async (req, res) => {
  try {
    const { newPassword, idToken, otpToken } = req.body;
    const phone = cleanPhone(req.body.phone);

    if (!phone || !newPassword) {
      return res.status(400).json({ message: "Phone and new password are required" });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters." });
    }

    // 🔐 New app: MSG91 otpToken. Old app versions: Firebase idToken (until everyone updates).
    let verifiedPhone;
    try {
      verifiedPhone = otpToken ? verifyOtpToken(otpToken, "reset") : await verifyPhoneIdToken(idToken);
    } catch (e) {
      return res.status(401).json({
        message: "OTP verification expired. Please verify your phone number again.",
      });
    }
    if (!samePhone(verifiedPhone, phone)) {
      return res.status(403).json({ message: "Verified phone number does not match this account." });
    }

    const user = await User.findOne({ phone: { $in: phoneCandidates(req.body.phone) } });
    if (!user) return res.status(404).json({ message: "User not found" });

    user.password = await bcrypt.hash(String(newPassword), 10);
    user.sessionToken = ""; // invalidate single-device sessions if enabled later
    await user.save();

    res.status(200).json({ message: "Password reset successfully" });
  } catch (error) {
    console.error("Reset Password Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// PROFILE
// =====================================================
const getUserProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select(PUBLIC_FIELDS);
    if (!user) return res.status(404).json({ message: "User not found" });
    res.status(200).json(user);
  } catch (error) {
    console.error("Get Profile Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// ADMIN: ONE STUDENT  GET /api/admin/student/:id
// Used by the Student Control screen to stay live (no refresh needed).
// =====================================================
const getStudentById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ message: "Valid id required" });
    const user = await User.findById(id).select(PUBLIC_FIELDS).lean();
    if (!user) return res.status(404).json({ message: "User not found" });
    res.set("Cache-Control", "no-store");
    res.status(200).json({ user: { ...user, id: user._id } });
  } catch (error) {
    console.error("Get Student Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// ADMIN: STUDENT LIST
// ?mode=online|offline|all  &page=1&limit=100 (optional — default returns all)
// =====================================================
const getAllUsers = async (req, res) => {
  try {
    const query = { role: "student" };
    const mode = normMode(req.query.mode);
    if (mode) query.mode = mode;

    const batch = normBatch(req.query.batchTime);
    if (batch) query.batchTime = batch;

    if (req.query.search) {
      const s = escapeRegex(String(req.query.search).trim().slice(0, 50));
      query.$or = [{ name: { $regex: s, $options: "i" } }, { phone: { $regex: s } }];
    }

    const limit = Math.min(Number(req.query.limit) || 0, 500);
    const page = Math.max(Number(req.query.page) || 1, 1);

    let cursor = User.find(query).select(PUBLIC_FIELDS).sort({ createdAt: -1 }).lean();
    if (limit) cursor = cursor.skip((page - 1) * limit).limit(limit);

    const [students, total] = await Promise.all([cursor, User.countDocuments(query)]);

    res.status(200).json({
      success: true,
      total,
      page: limit ? page : 1,
      totalPages: limit ? Math.max(Math.ceil(total / limit), 1) : 1,
      students,
    });
  } catch (error) {
    console.error("Get All Users Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const getUsersByStage = async (req, res) => {
  try {
    const query = { role: "student" };
    const stage = normStage(req.query.stage);
    const language = normLanguage(req.query.language) || "English";
    if (stage) query[`${language === "Hindi" ? "hindiAccess" : "englishAccess"}.${stage}`] = true;

    const users = await User.find(query).select(PUBLIC_FIELDS).lean();
    res.status(200).json(users);
  } catch (error) {
    console.error("Get Users By Stage Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const getAllTeachersFiltered = async (req, res) => {
  try {
    const query = { role: { $in: STAFF_ROLES } };
    const mode = normMode(req.query.mode);
    const language = normLanguage(req.query.language);
    const stage = normStage(req.query.stage);

    if (mode) query.mode = mode;
    if (language) query.language = language;
    if (!isAll(req.query.stage) && stage) {
      const n = stage.replace("stage", "");
      query.teacherStage = { $regex: `^stage\\s*${n}$`, $options: "i" };
    }

    const teachers = await User.find(query).select(PUBLIC_FIELDS).lean();
    res.status(200).json({ success: true, total: teachers.length, teachers });
  } catch (error) {
    console.error("Get Teachers Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// ADMIN: UPDATE ACCESS / STATUS / DELETE
// =====================================================
// Applies englishBatch / hindiBatch from the request body (admin panel).
// Timings of stages that are switched off are cleared. Returns an error message or null.
const applyStageBatches = (user, body) => {
  const english = cleanBatchMap(body.englishBatch);
  const hindi = cleanBatchMap(body.hindiBatch);
  if (english) user.englishBatch = english;
  if (hindi) user.hindiBatch = hindi;

  for (const [accessField, batchField] of [
    ["englishAccess", "englishBatch"],
    ["hindiAccess", "hindiBatch"],
  ]) {
    const access = user[accessField] || {};
    const batches = { ...emptyBatchMap(), ...(user[batchField] ? JSON.parse(JSON.stringify(user[batchField])) : {}) };
    for (const k of STAGE_KEYS) if (access[k] !== true) batches[k] = "";
    user[batchField] = batches;
  }
  return findBatchConflict(user);
};

const updateUserAccess = async (req, res) => {
  try {
    const { userId, mode, onlineSection } = req.body;
    if (!isValidId(userId)) return res.status(400).json({ message: "Valid userId required" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const english = cleanAccessMap(req.body.englishAccess);
    const hindi = cleanAccessMap(req.body.hindiAccess);
    if (english) user.englishAccess = english;
    if (hindi) user.hindiAccess = hindi;
    if (normMode(mode)) user.mode = normMode(mode);
    if (onlineSection) user.onlineSection = normSection(onlineSection);
    // Admin app sends access + timings together, so the clash check sees the NEW timings
    if (req.body.batchTime !== undefined) {
      const batch = normBatch(req.body.batchTime);
      if (req.body.batchTime && !batch) return res.status(400).json({ message: "Invalid batch timing" });
      user.batchTime = batch || "";
    }

    const clash = applyStageBatches(user, req.body);
    if (clash) return res.status(409).json({ message: clash });

    await user.save();

    if (req.io) {
      req.io.to(String(user._id)).emit("permissions_updated", {
        englishAccess: user.englishAccess,
        hindiAccess: user.hindiAccess,
        englishBatch: user.englishBatch,
        hindiBatch: user.hindiBatch,
        mode: user.mode,
        onlineSection: user.onlineSection,
      });
    }
    notifyAdmins(req, "student_update", { userId: String(user._id), by: req.user && String(req.user._id) === String(user._id) ? "student" : "admin", user: toPublicUser(user) });

    const out = user.toObject();
    delete out.password;
    delete out.sessionToken;
    res.status(200).json({ message: "User access updated successfully", user: out });
  } catch (error) {
    console.error("Update User Access Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const updateStudentStatus = async (req, res) => {
  try {
    const { userId, feeStatus, onlineSection, mode, batchTime } = req.body;
    if (!isValidId(userId)) return res.status(400).json({ message: "Valid userId required" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (feeStatus === "paid" || feeStatus === "unpaid") {
      user.feeStatus = feeStatus;
      if (feeStatus === "paid") {
        user.lastFeePaymentDate = new Date();
        user.feeVerifiedBy = req.user._id;
      }
    }
    if (onlineSection) user.onlineSection = normSection(onlineSection);
    if (normMode(mode)) user.mode = normMode(mode);
    if (batchTime !== undefined) {
      const batch = normBatch(batchTime);
      if (batchTime && !batch) return res.status(400).json({ message: "Invalid batch timing" });
      user.batchTime = batch || "";
    }

    const clash = applyStageBatches(user, req.body);
    if (clash) return res.status(409).json({ message: clash });

    await user.save();

    if (req.io) {
      req.io.to(String(user._id)).emit("permissions_updated", {
        feeStatus: user.feeStatus,
        onlineSection: user.onlineSection,
        mode: user.mode,
        batchTime: user.batchTime,
        englishBatch: user.englishBatch,
        hindiBatch: user.hindiBatch,
      });
    }
    notifyAdmins(req, "student_update", { userId: String(user._id), by: req.user && String(req.user._id) === String(user._id) ? "student" : "admin", user: toPublicUser(user) });

    const out = user.toObject();
    delete out.password;
    delete out.sessionToken;
    res.status(200).json({ message: "Student status updated", user: out });
  } catch (error) {
    console.error("Update Student Status Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// =====================================================
// BATCH TIMINGS
// =====================================================
// GET /api/batches  (public) — the 7 timings, so apps never hard-code a wrong label
const getBatches = (req, res) => {
  res.status(200).json({ batches: BATCHES.map(({ id, number, label, period }) => ({ id, number, label, period })) });
};

// PUT /api/user/batch-time
//   { batchTime }                              → default timing (signup choice)
//   { batchTime, language: "English", stage }  → timing for one enabled stage
const updateMyBatchTime = async (req, res) => {
  try {
    const batch = normBatch(req.body.batchTime);
    if (!batch) return res.status(400).json({ message: "Please choose a valid batch timing" });

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.role !== "student") return res.status(403).json({ message: "Only students choose a batch timing" });

    const stage = req.body.stage ? normStage(req.body.stage) : null;
    if (req.body.stage && !stage) return res.status(400).json({ message: "Invalid stage" });

    if (stage) {
      const language = normLanguage(req.body.language) || "English";
      const accessField = language === "Hindi" ? "hindiAccess" : "englishAccess";
      if (!(user[accessField] && user[accessField][stage] === true)) {
        return res.status(403).json({ message: `${language} ${stage.replace("stage", "Stage ")} is not enabled for you yet.` });
      }
      const field = batchFieldFor(language);
      const map = { ...emptyBatchMap(), ...(user[field] ? JSON.parse(JSON.stringify(user[field])) : {}) };
      map[stage] = batch;
      user[field] = map;
    } else {
      user.batchTime = batch;
    }

    const clash = findBatchConflict(user);
    if (clash) return res.status(409).json({ message: clash });

    await user.save();

    notifyAdmins(req, "student_update", { userId: String(user._id), by: req.user && String(req.user._id) === String(user._id) ? "student" : "admin", user: toPublicUser(user) });
    if (req.io) {
      req.io.to(String(user._id)).emit("permissions_updated", {
        batchTime: user.batchTime,
        englishBatch: user.englishBatch,
        hindiBatch: user.hindiBatch,
      });
    }

    res.status(200).json({
      message: "Batch timing updated",
      batchTime: user.batchTime,
      englishBatch: user.englishBatch,
      hindiBatch: user.hindiBatch,
      user: toPublicUser(user),
    });
  } catch (error) {
    console.error("Update Batch Time Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// DELETE /users/:id
//  • a student may delete ONLY their own account (student app "Delete account")
//  • manager/admin may delete students; only admin may delete staff
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ message: "Invalid id" });

    const isSelf = String(id) === String(req.user._id);
    const isAdminUser = ADMIN_ROLES.includes(req.user.role);

    if (isSelf && isAdminUser) {
      return res.status(400).json({ message: "Staff accounts cannot delete themselves here." });
    }
    if (!isSelf && !isAdminUser) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const target = await User.findById(id).select("role").lean();
    if (!target) return res.status(404).json({ message: "User not found" });
    if (!isSelf && target.role !== "student" && req.user.role !== "admin") {
      return res.status(403).json({ message: "Only an admin can delete staff accounts." });
    }

    await User.deleteOne({ _id: id });
    notifyAdmins(req, "student_update", { userId: String(id), deleted: true });

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
  getStudentById,
  getUsersByStage,
  getAllTeachersFiltered,
  updateUserAccess,
  updateStudentStatus,
  deleteUser,
  getBatches,
  updateMyBatchTime,
  resetMonthlyFeesForNewMonth,
};
