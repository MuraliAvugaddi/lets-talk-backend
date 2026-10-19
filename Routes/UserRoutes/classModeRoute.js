const express = require("express");
const router = express.Router();
const {
  getClassModes,
  setRainMode,
  setAssemblyMode,
  getAssemblyReport,
  getAssemblyPeople,
} = require("../../Controllers/UserContollers/classModeController");
const { requireAuth } = require("../../middleware/authMiddleware");

const ADMIN = ["manager", "admin"];

router.get("/", getClassModes); // all apps
router.post("/rain", requireAuth(...ADMIN), setRainMode); // 🌧 offline → online
router.post("/assembly", requireAuth(...ADMIN), setAssemblyMode); // 🎙 principal class
router.get("/assembly/report", requireAuth(...ADMIN), getAssemblyReport); // 📋 who attended / absent
router.get("/assembly/people", requireAuth(...ADMIN), getAssemblyPeople); // trainer ids for the host screen

module.exports = router;
