const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const cors = require("cors");
const cron = require("node-cron");

const userRoutes = require("./Routes/UserRoutes/authRoute");
const testRoutes = require("./Routes/UserRoutes/testRoute");
const liveRoutes = require("./Routes/UserRoutes/liveRoute");
// 1. Import your new stream auth route file (adjust filename/path if named differently)
const streamRoute = require("./Routes/UserRoutes/streamRoute");

// Import controllers and models
const { autoMarkAbsent } = require("./Controllers/UserContollers/attendanceController");
const User = require("./Models/users");
const Attendance = require("./Models/attendance");

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 5000;

// Attach io to requests
app.use((req, res, next) => {
  req.io = io;
  next();
});

app.use(cors());
app.use(express.json());

// Routes
app.use("/api", userRoutes);
app.use("/api/test", testRoutes);
app.use("/api/live", liveRoutes);
// 2. Mount the stream token route under /api so it becomes /api/get-stream-token
app.use("/api/stream", streamRoute);

// Socket Connection Handler
io.on("connection", (socket) => {
  socket.on("join_user_room", (userId) => {
    socket.join(userId);
  });
});

// Database Connection & Auto Drop Old Indexes
mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("MongoDB is connected successfully");

    // 1. Drop old email index if exists
    try {
      await User.collection.dropIndex("email_1");
      console.log("✅ Successfully dropped old email index!");
    } catch (err) {
      console.log("ℹ️ No old email index found.");
    }

    // 2. 🛑 Drop old attendance unique index { userId: 1, date: 1 }
    try {
      await Attendance.collection.dropIndex("userId_1_date_1");
      console.log("✅ Successfully dropped old attendance index (userId_1_date_1)!");
    } catch (err) {
      console.log("ℹ️ No old attendance index found or already dropped.");
    }
  })
  .catch((error) => console.log(error));

// 🕒 Scheduled Cron Job: Runs every day at 6:40 PM (18:40) to auto-mark absentees who missed all batches
cron.schedule('40 18 * * *', async () => {
  console.log('Running 6:40 PM daily auto-absent cutoff job...');
  try {
    await autoMarkAbsent();
    console.log('Auto-absent successfully locked for unrecorded users.');
  } catch (err) {
    console.error('Error running 6:40 PM auto-absent cron:', err);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is connected Port at ${PORT}`);
});