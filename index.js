const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const cors = require("cors");
const cron = require("node-cron");

// =====================================================
// ENVIRONMENT
// =====================================================

dotenv.config();

// =====================================================
// ROUTES
// =====================================================

const userRoutes = require("./Routes/UserRoutes/authRoute");
const testRoutes = require("./Routes/UserRoutes/testRoute");
const liveRoutes = require("./Routes/UserRoutes/liveRoute");
const streamRoute = require("./Routes/UserRoutes/streamRoute");
const sectionMergeRoutes = require("./Routes/UserRoutes/sectionMergeRoute");
const feeRoutes = require("./Routes/UserRoutes/feeRoute");

// =====================================================
// CONTROLLERS
// =====================================================

const {
  autoMarkAbsent,
} = require("./Controllers/UserContollers/attendanceController");

const {
  resetMonthlyFeesForNewMonth,
} = require("./Controllers/UserContollers/authController");

// =====================================================
// EXPRESS APP
// =====================================================

const app = express();
const server = http.createServer(app);

// =====================================================
// SOCKET.IO
// =====================================================

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// =====================================================
// PORT
// =====================================================

const PORT = process.env.PORT || 5000;

// =====================================================
// MIDDLEWARE
// =====================================================

app.use(cors());
app.use(express.json());

// Attach Socket.IO to every request so controllers can broadcast events live
app.use((req, res, next) => {
  req.io = io;
  next();
});

// =====================================================
// ROUTES
// =====================================================

app.use("/api", userRoutes);
app.use("/api/test", testRoutes);
app.use("/api/live", liveRoutes);
app.use("/api/stream", streamRoute);
app.use("/api/admin", sectionMergeRoutes);
app.use("/api/fee", feeRoutes);

// =====================================================
// BASIC HEALTH CHECK
// =====================================================

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Let's Speak Backend is running",
    database:
      mongoose.connection.readyState === 1
        ? "connected"
        : "disconnected",
    time: new Date().toISOString(),
  });
});

// =====================================================
// SOCKET CONNECTION & ROOM MAPPING
// =====================================================

io.on("connection", (socket) => {
  console.log("🔌 Client connected:", socket.id);

  // -----------------------------------------------
  // JOIN USER ROOM (Ensures student receives permission updates)
  // -----------------------------------------------
  socket.on("join_user_room", (userId) => {
    if (!userId) {
      console.log("⚠️ No userId provided for room join");
      return;
    }
    const cleanId = String(userId).trim();
    socket.join(cleanId);
    console.log(`👤 User joined personal update room: ${cleanId}`);
  });

  // -----------------------------------------------
  // JOIN ADMIN ROOM
  // -----------------------------------------------
  socket.on("join_admin_room", () => {
    socket.join("admin_room");
    console.log(`🛠️ Admin joined broadcast room: ${socket.id}`);
  });

  // -----------------------------------------------
  // DISCONNECT
  // -----------------------------------------------
  socket.on("disconnect", (reason) => {
    console.log(`🔌 Client disconnected: ${socket.id} | Reason: ${reason}`);
  });
});

// =====================================================
// MONGODB CONNECTION WITH HIGH-SCALE POOLING
// =====================================================

const connectDatabase = async () => {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error("MONGO_URI is missing in environment variables");
    }

    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      maxPoolSize: 50,
      minPoolSize: 10,
    });

    console.log("========================================");
    console.log("✅ MongoDB is connected successfully (High Scale Pool Active)");
    console.log(`📊 Database: ${mongoose.connection.name}`);
    console.log("========================================");
  } catch (error) {
    console.error("========================================");
    console.error("❌ MongoDB connection failed");
    console.error(error.message);
    console.error("========================================");

    process.exit(1);
  }
};

// =====================================================
// MONGODB EVENTS
// =====================================================

mongoose.connection.on("connected", () => {
  console.log("🟢 MongoDB connection established");
});

mongoose.connection.on("error", (error) => {
  console.error("❌ MongoDB error:", error.message);
});

mongoose.connection.on("disconnected", () => {
  console.log("🔴 MongoDB disconnected");
});

// =====================================================
// CRON JOB 1: AUTO MARK ABSENT
// =====================================================

const autoAbsentCron = cron.schedule(
  "50 18 * * *",
  async () => {
    if (mongoose.connection.readyState !== 1) return;
    try {
      await autoMarkAbsent();
      console.log("✅ Auto-absent completed successfully");
    } catch (error) {
      console.error("❌ Auto-absent cron error:", error);
    }
  },
  {
    timezone: "Asia/Kolkata",
    noOverlap: true,
  }
);

// =====================================================
// CRON JOB 2: MONTHLY FEE RESET
// =====================================================

const monthlyFeeCron = cron.schedule(
  "0 0 1 * *",
  async () => {
    if (mongoose.connection.readyState !== 1) return;
    try {
      await resetMonthlyFeesForNewMonth();
      console.log("✅ Monthly fee reset completed successfully");
    } catch (error) {
      console.error("❌ Monthly fee reset cron error:", error);
    }
  },
  {
    timezone: "Asia/Kolkata",
    noOverlap: true,
  }
);

// =====================================================
// START SERVER
// =====================================================

const startServer = async () => {
  try {
    await connectDatabase();

    server.listen(PORT, "0.0.0.0", () => {
      console.log("");
      console.log("========================================");
      console.log("🚀 LET'S SPEAK BACKEND STARTED");
      console.log("========================================");
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🌐 Local: http://localhost:${PORT}`);
      console.log("🇮🇳 Cron timezone: Asia/Kolkata");
      console.log("🟢 MongoDB: Connected");
      console.log("========================================");
      console.log("");
    });
  } catch (error) {
    console.error("❌ Server startup failed:", error);
    process.exit(1);
  }
};

// =====================================================
// GRACEFUL SHUTDOWN & UNHANDLED ERRORS
// =====================================================

const shutdown = async (signal) => {
  try {
    autoAbsentCron.stop();
    monthlyFeeCron.stop();
    server.close();
    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    process.exit(1);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  console.error("❌ UNHANDLED PROMISE REJECTION", reason);
});

process.on("uncaughtException", (error) => {
  console.error("❌ UNCAUGHT EXCEPTION", error);
  setTimeout(() => process.exit(1), 1000);
});

startServer();