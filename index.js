const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const cors = require("cors");

const userRoutes = require("./Routes/UserRoutes/authRoute");
const testRoutes = require("./Routes/UserRoutes/testRoute");
const liveRoutes = require("./Routes/UserRoutes/liveRoute");

// Import models to clean up indexes
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

server.listen(PORT, () => {
  console.log(`Server is connected Port at ${PORT}`);
});