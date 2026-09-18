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

// Attach Socket.IO to every request
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
// SOCKET CONNECTION
// =====================================================

io.on("connection", (socket) => {
  console.log("🔌 User connected:", socket.id);

  // -----------------------------------------------
  // JOIN USER ROOM
  // -----------------------------------------------

  socket.on("join_user_room", (userId) => {
    if (!userId) {
      console.log("⚠️ No userId provided for room");
      return;
    }

    socket.join(String(userId));

    console.log(`👤 User ${userId} joined room`);
  });

  // -----------------------------------------------
  // DISCONNECT
  // -----------------------------------------------

  socket.on("disconnect", (reason) => {
    console.log(
      `🔌 User disconnected: ${socket.id} | Reason: ${reason}`
    );
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
      maxPoolSize: 50, // 🚀 Scaled connection pool for 1500+ users
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

    // Exit so Render/server can restart the application
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
// CRON JOB 1
// AUTO MARK ABSENT
//
// Every day at 6:50 PM IST
// =====================================================

const autoAbsentCron = cron.schedule(
  "50 18 * * *",
  async () => {
    console.log("");
    console.log("========================================");
    console.log("🕒 6:50 PM AUTO-ABSENT CRON STARTED");
    console.log("🇮🇳 Timezone: Asia/Kolkata");
    console.log(`⏰ Server time: ${new Date().toISOString()}`);
    console.log("========================================");

    // -----------------------------------------------
    // Check MongoDB
    // -----------------------------------------------

    if (mongoose.connection.readyState !== 1) {
      console.error(
        "❌ Auto-absent skipped: MongoDB is not connected"
      );

      console.log("========================================");
      console.log("🕒 AUTO-ABSENT CRON FINISHED");
      console.log("========================================");

      return;
    }

    const startTime = Date.now();

    try {
      console.log("📌 Starting autoMarkAbsent()...");

      await autoMarkAbsent();

      const executionTime = Date.now() - startTime;

      console.log(
        `✅ Auto-absent completed successfully in ${executionTime} ms`
      );
    } catch (error) {
      console.error("❌ Auto-absent cron error:");
      console.error(error);
    }

    console.log("========================================");
    console.log("🕒 AUTO-ABSENT CRON FINISHED");
    console.log("========================================");
    console.log("");
  },
  {
    timezone: "Asia/Kolkata",
    noOverlap: true,
  }
);

// =====================================================
// CRON JOB 2
// MONTHLY FEE RESET
//
// Every month on the 1st day at 12:00 AM IST
// =====================================================

const monthlyFeeCron = cron.schedule(
  "0 0 1 * *",
  async () => {
    console.log("");
    console.log("========================================");
    console.log("🕛 MONTHLY FEE RESET CRON STARTED");
    console.log("🇮🇳 Timezone: Asia/Kolkata");
    console.log(`⏰ Server time: ${new Date().toISOString()}`);
    console.log("========================================");

    // -----------------------------------------------
    // Check MongoDB
    // -----------------------------------------------

    if (mongoose.connection.readyState !== 1) {
      console.error(
        "❌ Monthly fee reset skipped: MongoDB is not connected"
      );

      console.log("========================================");
      console.log("🕛 MONTHLY FEE RESET CRON FINISHED");
      console.log("========================================");

      return;
    }

    const startTime = Date.now();

    try {
      console.log(
        "📌 Starting resetMonthlyFeesForNewMonth()..."
      );

      await resetMonthlyFeesForNewMonth();

      const executionTime = Date.now() - startTime;

      console.log(
        `✅ Monthly fee reset completed successfully in ${executionTime} ms`
      );
    } catch (error) {
      console.error("❌ Monthly fee reset cron error:");
      console.error(error);
    }

    console.log("========================================");
    console.log("🕛 MONTHLY FEE RESET CRON FINISHED");
    console.log("========================================");
    console.log("");
  },
  {
    timezone: "Asia/Kolkata",
    noOverlap: true,
  }
);

// =====================================================
// CRON STATUS
// =====================================================

console.log("========================================");
console.log("⏰ CRON JOBS REGISTERED");
console.log("========================================");
console.log("🕒 Auto Absent    : Every day at 6:50 PM IST");
console.log("🕛 Monthly Reset  : 1st day of month at 12:00 AM IST");
console.log("🌏 Timezone       : Asia/Kolkata");
console.log("🔒 No Overlap     : Enabled");
console.log("========================================");

// =====================================================
// START SERVER
// =====================================================

const startServer = async () => {
  try {
    // -----------------------------------------------
    // Connect MongoDB first
    // -----------------------------------------------

    await connectDatabase();

    // -----------------------------------------------
    // Start HTTP server
    // -----------------------------------------------

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
// GRACEFUL SHUTDOWN
// =====================================================

const shutdown = async (signal) => {
  console.log("");
  console.log(`🛑 ${signal} received`);
  console.log("🛑 Shutting down server...");

  try {
    // Stop cron jobs
    autoAbsentCron.stop();
    monthlyFeeCron.stop();

    console.log("⏰ Cron jobs stopped");

    // Close HTTP server
    server.close(() => {
      console.log("🌐 HTTP server closed");
    });

    // Close MongoDB
    await mongoose.connection.close();

    console.log("🗄️ MongoDB connection closed");

    console.log("✅ Server shutdown completed");

    process.exit(0);
  } catch (error) {
    console.error("❌ Shutdown error:", error);
    process.exit(1);
  }
};

// =====================================================
// PROCESS SIGNALS
// =====================================================

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

// =====================================================
// UNHANDLED ERRORS
// =====================================================

process.on("unhandledRejection", (reason) => {
  console.error("========================================");
  console.error("❌ UNHANDLED PROMISE REJECTION");
  console.error(reason);
  console.error("========================================");
});

process.on("uncaughtException", (error) => {
  console.error("========================================");
  console.error("❌ UNCAUGHT EXCEPTION");
  console.error(error);
  console.error("========================================");

  // Give the process a moment to log the error
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

// =====================================================
// START APPLICATION
// =====================================================

startServer();