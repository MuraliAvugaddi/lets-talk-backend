const express = require("express");
const router = express.Router();
const c = require("../../Controllers/UserContollers/classRequestController");
const { requireAuth } = require("../../middleware/authMiddleware");

const STAFF = ["manager", "admin"];

// 🎓 student
router.get("/my-classes", requireAuth("student"), c.myClasses);
router.get("/mine", requireAuth("student"), c.myRequests);
router.post("/", requireAuth("student"), c.createRequest);

// 👩‍🏫 trainer
router.get("/trainer", requireAuth("teacher"), c.trainerRequests);
router.post("/:id/accept", requireAuth("teacher"), c.accept);
router.post("/:id/escalate", requireAuth("teacher"), c.escalate);

// 🧑‍💼 manager / admin
router.get("/manager", requireAuth(...STAFF), c.managerRequests);
router.post("/:id/solve", requireAuth(...STAFF), c.solve);

// everyone in the request
router.get("/:id", requireAuth(), c.getRequest);
router.post("/:id/reply", requireAuth(), c.reply);

module.exports = router;
