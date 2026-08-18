const express = require("express");
const router = express.Router();
const { updateLink, deleteLink, getLink } = require("../../Controllers/UserContollers/liveController");

router.post("/admin/update", updateLink);
router.delete("/admin/delete", deleteLink);
router.get("/user/get", getLink);

module.exports = router;