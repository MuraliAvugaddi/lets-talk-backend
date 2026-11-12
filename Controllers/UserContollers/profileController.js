// =====================================================
// 👤 PROFILE — student edits own name / photo / phone, admin edits trainers
//
// Student (any logged-in user)
//   PUT    /api/user/profile          { name }
//   POST   /api/user/profile-photo    multipart "photo"  (max 5 MB)
//   DELETE /api/user/profile-photo
//   POST   /api/user/change-phone     { otpToken }   ← from /api/otp/send + /api/otp/verify
//                                      with purpose "change" sent to the NEW number
//   (online / offline can NOT be changed here — only the admin does that)
//
// Admin / manager
//   PUT    /api/admin/staff/:id       { name, phone, password, language, mode, teacherStage, teacherSection }
// =====================================================
const bcrypt = require("bcryptjs");
const User = require("../../Models/users");
const { verifyOtpToken } = require("./otpController");
const { uploadProfilePhoto, deleteFromCloudinary } = require("../../utils/cloudinary");
const { isValidId, normLanguage, normMode, normStage, normSection } = require("../../utils/normalize");

const PUBLIC_FIELDS = "-password -sessionToken -fcmTokens";

const cleanPhone = (p) => String(p || "").replace(/\D/g, "").slice(-10);
const phoneCandidates = (p) => {
  const ten = cleanPhone(p);
  return [ten, `91${ten}`, `+91${ten}`, `0${ten}`];
};
const cleanName = (n) => String(n || "").replace(/\s+/g, " ").trim();

const publicUser = async (id) => User.findById(id).select(PUBLIC_FIELDS).lean();

const tellAdmins = (req, user) => {
  if (!req.io) return;
  req.io.to("admin_room").emit("student_update", {
    userId: String(user._id),
    by: "profile",
    user: { _id: user._id, id: user._id, name: user.name, phone: user.phone, photoUrl: user.photoUrl || "" },
  });
};

// PUT /user/profile
const updateMyProfile = async (req, res) => {
  try {
    const name = cleanName(req.body.name);
    if (name.length < 2 || name.length > 60) return res.status(400).json({ message: "Name must be 2 to 60 letters" });
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "Account not found" });
    user.name = name;
    await user.save();
    tellAdmins(req, user);
    res.status(200).json({ message: "Name updated ✅", user: await publicUser(user._id) });
  } catch (error) {
    console.error("Update Profile Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// POST /user/profile-photo
const uploadMyPhoto = async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ message: "Choose a photo" });
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "Account not found" });
    const up = await uploadProfilePhoto(req.file.buffer);
    const oldId = user.photoPublicId;
    user.photoUrl = up.secure_url;
    user.photoPublicId = up.public_id;
    await user.save();
    if (oldId) deleteFromCloudinary(oldId).catch(() => {});
    tellAdmins(req, user);
    res.status(200).json({ message: "Photo updated ✅", photoUrl: user.photoUrl, user: await publicUser(user._id) });
  } catch (error) {
    console.error("Upload Photo Error:", error);
    res.status(500).json({ message: "Could not upload the photo. Try again." });
  }
};

// DELETE /user/profile-photo
const removeMyPhoto = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "Account not found" });
    const oldId = user.photoPublicId;
    user.photoUrl = "";
    user.photoPublicId = "";
    await user.save();
    if (oldId) deleteFromCloudinary(oldId).catch(() => {});
    res.status(200).json({ message: "Photo removed", user: await publicUser(user._id) });
  } catch (error) {
    console.error("Remove Photo Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// POST /user/change-phone
const changeMyPhone = async (req, res) => {
  try {
    let phone;
    try {
      phone = verifyOtpToken(req.body.otpToken, "change");
    } catch (_) {
      return res.status(400).json({ message: "Verification expired. Please verify the new number again." });
    }
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "Account not found" });
    if (cleanPhone(user.phone) === phone) return res.status(400).json({ message: "This is already your number" });
    const taken = await User.exists({ _id: { $ne: user._id }, phone: { $in: phoneCandidates(phone) } });
    if (taken) return res.status(409).json({ message: "This number is already used by another account." });

    user.phone = phone;
    await user.save();
    tellAdmins(req, user);
    res.status(200).json({ message: "Phone number changed ✅ Use the new number to log in.", user: await publicUser(user._id) });
  } catch (error) {
    if (error && error.code === 11000) return res.status(409).json({ message: "This number is already used by another account." });
    console.error("Change Phone Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// PUT /admin/staff/:id  (trainer / manager)
const updateStaff = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ message: "Invalid id" });
    const staff = await User.findById(id);
    if (!staff || !["teacher", "manager"].includes(staff.role)) return res.status(404).json({ message: "Staff not found" });

    if (req.body.name !== undefined) {
      const name = cleanName(req.body.name);
      if (name.length < 2) return res.status(400).json({ message: "Enter the name" });
      staff.name = name;
    }
    if (req.body.phone !== undefined && cleanPhone(req.body.phone) !== cleanPhone(staff.phone)) {
      const phone = cleanPhone(req.body.phone);
      if (phone.length !== 10) return res.status(400).json({ message: "Enter a valid 10-digit phone number" });
      const taken = await User.exists({ _id: { $ne: staff._id }, phone: { $in: phoneCandidates(phone) } });
      if (taken) return res.status(409).json({ message: "This phone number is already used by another account" });
      staff.phone = phone;
    }
    let passwordChanged = false;
    if (req.body.password) {
      const pw = String(req.body.password);
      if (pw.length < 6) return res.status(400).json({ message: "Password must be at least 6 characters" });
      staff.password = await bcrypt.hash(pw, 10);
      staff.sessionToken = ""; // log out from the old phone
      passwordChanged = true;
    }
    if (staff.role === "teacher") {
      const language = req.body.language !== undefined ? normLanguage(req.body.language) : null;
      if (language) staff.language = language;
      const mode = req.body.mode !== undefined ? normMode(req.body.mode) : null;
      if (mode) staff.mode = staff.language === "Hindi" ? "online" : mode;
      const stage = req.body.teacherStage !== undefined ? normStage(req.body.teacherStage) : null;
      if (stage) staff.teacherStage = stage;
      if (req.body.teacherSection !== undefined) {
        staff.teacherSection =
          staff.language === "English" && staff.mode === "online" ? normSection(req.body.teacherSection) : "None";
      }
    }
    await staff.save();
    if (passwordChanged && req.io) {
      req.io.to(String(staff._id)).emit("force_logout", { message: "Your password was changed by the admin. Please log in again." });
    }
    res.status(200).json({ message: `${staff.name} updated ✅`, staff: await publicUser(staff._id) });
  } catch (error) {
    if (error && error.code === 11000) return res.status(409).json({ message: "This phone number is already used" });
    console.error("Update Staff Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { updateMyProfile, uploadMyPhoto, removeMyPhoto, changeMyPhone, updateStaff };
