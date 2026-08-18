const User = require("../../Models/users");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

// @desc    Register a new user
const registerUser = async (req, res) => {
  try {
    const { name, phone, password, mode, role } = req.body;

    if (!name || !phone || !password || !mode) {
      return res.status(400).json({ message: "Please provide all required fields." });
    }

    const existingUser = await User.findOne({ phone });
    if (existingUser) {
      return res.status(400).json({ message: "Phone number is already registered." });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const sessionToken = Date.now().toString() + "_" + Math.random().toString(36).substring(2);

    const newUser = new User({
      name,
      phone,
      password: hashedPassword,
      mode,
      role: role || "student",
      sessionToken,
    });

    await newUser.save();

    const token = jwt.sign(
      { id: newUser._id, sessionToken },
      process.env.JWT_SECRET || "secret_key",
      { expiresIn: "30d" }
    );

    res.status(201).json({
      message: "Registration successful!",
      token,
      user: {
        id: newUser._id,
        _id: newUser._id,
        name: newUser.name,
        phone: newUser.phone,
        mode: newUser.mode,
        role: newUser.role,
        englishAccess: newUser.englishAccess,
        hindiAccess: newUser.hindiAccess,
      },
    });
  } catch (error) {
    console.error("Error in registerUser:", error);
    res.status(500).json({ message: "Server error during registration" });
  }
};

// @desc    Auth user & get token (Login)
const loginUser = async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ message: "Please enter phone number and password" });
    }

    const user = await User.findOne({ phone });

    if (user && (await bcrypt.compare(password, user.password))) {
      // 🛑 Kick other devices instantly via socket
      if (req.io) {
        req.io.to(user._id.toString()).emit("force_logout", {
          message: "You have been logged out because your account was accessed from another device.",
        });
      }

      const newSessionToken = Date.now().toString() + "_" + Math.random().toString(36).substring(2);
      user.sessionToken = newSessionToken;
      await user.save();

      const token = jwt.sign(
        { id: user._id, sessionToken: newSessionToken },
        process.env.JWT_SECRET || "secret_key",
        { expiresIn: "30d" }
      );

      res.json({
        message: "Login successful",
        token,
        user: {
          id: user._id,
          _id: user._id,
          name: user.name,
          phone: user.phone,
          mode: user.mode,
          role: user.role,
          englishAccess: user.englishAccess,
          hindiAccess: user.hindiAccess,
        },
      });
    } else {
      res.status(401).json({ message: "Invalid phone number or password" });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Update User Access (Lock/Unlock Stages) & Emit Live Socket Event
const updateUserAccess = async (req, res) => {
  try {
    const { userId, englishAccess, hindiAccess } = req.body;

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { englishAccess, hindiAccess },
      { new: true }
    ).select("-password");

    if (updatedUser) {
      // ⚡ Broadcast permissions immediately to the student's open app
      if (req.io) {
        req.io.to(userId.toString()).emit("permissions_updated", {
          englishAccess: updatedUser.englishAccess,
          hindiAccess: updatedUser.hindiAccess,
        });
      }

      res.json({ message: "Access Updated", user: updatedUser });
    } else {
      res.status(404).json({ message: "User not found" });
    }
  } catch (error) {
    console.error("Error updating access:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Reset Password
const resetPassword = async (req, res) => {
  try {
    const { phone, newPassword } = req.body;
    if (!phone || !newPassword) return res.status(400).json({ message: "Missing fields" });

    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ message: "User not found" });

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    res.status(200).json({ message: "Password reset successful!" });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Get User Profile
const getUserProfile = async (req, res) => {
  if (req.user) {
    const freshUser = await User.findById(req.user._id).select("-password");
    if (freshUser) {
      res.json({
        _id: freshUser._id,
        id: freshUser._id,
        name: freshUser.name,
        phone: freshUser.phone,
        mode: freshUser.mode,
        role: freshUser.role,
        englishAccess: freshUser.englishAccess,
        hindiAccess: freshUser.hindiAccess,
      });
    } else {
      res.status(404).json({ message: "User not found" });
    }
  } else {
    res.status(404).json({ message: "User not found" });
  }
};

// @desc    Get All Users with Pagination
const getAllUsers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const users = await User.find({})
      .select("-password")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await User.countDocuments();

    res.json({
      users,
      currentPage: page,
      totalPages: Math.ceil(total / limit),
      totalUsers: total,
    });
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Delete User
const deleteUser = async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (user) {
      res.json({ message: "User deleted successfully" });
    } else {
      res.status(404).json({ message: "User not found" });
    }
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Get Users By Stage (Offline)
const getUsersByStage = async (req, res) => {
  try {
    const allUsers = await User.find({}).select("name phone mode englishAccess");
    const offlineUsers = allUsers.filter(
      (u) => u.mode && u.mode.toString().trim().toLowerCase() === "offline"
    );
    res.status(200).json(offlineUsers);
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = {
  registerUser,
  loginUser,
  resetPassword,
  getUserProfile,
  getAllUsers,
  updateUserAccess,
  deleteUser,
  getUsersByStage,
};