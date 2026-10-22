// Must be the very first line: every Date in this process uses India time.
// (Attendance logic also uses explicit IST helpers in utils/time.js.)
process.env.TZ = "Asia/Kolkata";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const cors = require("cors");
const compression = require("compression");
const cron = require("node-cron");

dotenv.config();

const { getJwtSecret, resolveUser } = require("./middleware/authMiddleware");
const { STAFF_ROLES } = require("./utils/normalize");

// =====================================================
// ENVIRONMENT CHECK — fail fast instead of running half-configured
// =====================================================
try {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is missing");
  getJwtSecret();
} catch (err) {
  console.error(`❌ Config error: ${err.message}`);
  process.exit(1);
}
if (!process.env.STREAM_API_KEY || !process.env.STREAM_API_SECRET) {
  console.warn("⚠️ STREAM_API_KEY / STREAM_API_SECRET not set — live classes will fail to get tokens");
}
console.log(`🎧 Live classes: ${String(process.env.LIVE_PROVIDER || "stream").toLowerCase() === "livekit" ? "LiveKit (own server)" : "Stream"}`);
console.log(`🔐 ENFORCE_AUTH = ${process.env.ENFORCE_AUTH === "true" ? "ON" : "OFF (transition mode)"}`);

// =====================================================
// ROUTES / CONTROLLERS
// =====================================================
const userRoutes = require("./Routes/UserRoutes/authRoute");
const testRoutes = require("./Routes/UserRoutes/testRoute");
const liveRoutes = require("./Routes/UserRoutes/liveRoute");
const streamRoute = require("./Routes/UserRoutes/streamRoute");
const sectionMergeRoutes = require("./Routes/UserRoutes/sectionMergeRoute");
const feeRoutes = require("./Routes/UserRoutes/feeRoute");
const practiceRoutes = require("./Routes/UserRoutes/practiceRoute");
const promoRoutes = require("./Routes/UserRoutes/promoRoute");
const classModeRoutes = require("./Routes/UserRoutes/classModeRoute");
const rtcRoutes = require("./Routes/UserRoutes/rtcRoute");

const { autoMarkAbsent } = require("./Controllers/UserContollers/attendanceController");
const { resetMonthlyFeesForNewMonth } = require("./Controllers/UserContollers/authController");

// =====================================================
// APP + SOCKET.IO
// =====================================================
const app = express();
const server = http.createServer(app);

app.set("trust proxy", 1); // Render sits behind a proxy (needed for correct client IPs / rate limits)
app.disable("x-powered-by");

const corsOrigin = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim()) : "*";

const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ["GET", "POST"] },
  pingInterval: 25000,
  pingTimeout: 20000,
});

app.use(cors({ origin: corsOrigin }));
// gzip: the admin's 2,500-student list is ~10x smaller (3 MB → ~300 KB). Apps unzip it automatically.
app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: "1mb" }));

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
app.use("/api/practice", practiceRoutes);
app.use("/api/promo", promoRoutes); // posters & reels on the student home screen
app.use("/api/class-mode", classModeRoutes); // 🌧 rain day / 🎙 principal class
app.use("/api/rtc", rtcRoutes); // 🎧 LiveKit audio classes (own server)

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Let's Speak Backend is running",
    database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    time: new Date().toISOString(),
  });
});

// 404
app.use((req, res) => res.status(404).json({ message: "Not found" }));

// Central error handler (multer limits, bad JSON, etc.)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && (err.code === "LIMIT_FILE_SIZE" || err.name === "MulterError")) {
    return res.status(400).json({ message: err.code === "LIMIT_FILE_SIZE" ? "File too large (max 5 MB)" : err.message });
  }
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Invalid JSON body" });
  }
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error("❌ Unhandled route error:", err);
  res.status(status).json({ message: status >= 500 ? "Server Error" : err.message });
});

// =====================================================
// SOCKET AUTH + ROOMS
// Clients may send their JWT: io(url, { auth: { token } }).
// =====================================================
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (token) {
    const { user } = await resolveUser(String(token));
    if (user) socket.data.user = user;
  }
  next();
});

io.on("connection", (socket) => {
  const user = socket.data.user;
  const enforce = process.env.ENFORCE_AUTH === "true";

  // Auto-join own room when the token is known
  if (user) socket.join(String(user._id));

  socket.on("join_user_room", (userId) => {
    if (!userId) return;
    const cleanId = String(userId).trim();
    if (user && String(user._id) !== cleanId) return; // can't listen to someone else's room
    if (!user && enforce) return;
    socket.join(cleanId);
  });

  socket.on("join_admin_room", () => {
    if (user && !STAFF_ROLES.includes(user.role)) return;
    if (!user && enforce) return;
    socket.join("admin_room");
  });
});

// =====================================================
// DATABASE
// =====================================================
const connectDatabase = async () => {
  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 50,
    minPoolSize: 5,
  });
  console.log(`✅ MongoDB connected (${mongoose.connection.name})`);
};

// One-time fixes for indexes that were causing data loss / collisions
const runStartupMigrations = async () => {
  const drop = async (collection, indexName, why) => {
    try {
      await mongoose.connection.db.collection(collection).dropIndex(indexName);
      console.log(`🧹 Dropped index ${collection}.${indexName} (${why})`);
    } catch (err) {
      if (err.codeName !== "IndexNotFound" && err.code !== 27 && err.codeName !== "NamespaceNotFound") {
        console.warn(`⚠️ Could not drop ${collection}.${indexName}: ${err.message}`);
      }
    }
  };
  await drop("results", "completedAt_1", "TTL was deleting test results after 4 days");

  // 🧹 Any TTL index left from old schemas (tests.createdAt, results.completedAt, …) keeps deleting
  // documents in MongoDB even after `expires` was removed from the code. None of our data should
  // expire on its own, so remove every TTL index we find.
  try {
    const collections = await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray();
    for (const { name } of collections) {
      if (name.startsWith("system.")) continue;
      const indexes = await mongoose.connection.db.collection(name).indexes().catch(() => []);
      for (const ix of indexes) {
        if (ix.expireAfterSeconds !== undefined && ix.name !== "_id_") {
          await drop(name, ix.name, `TTL index (expireAfterSeconds=${ix.expireAfterSeconds}) was auto-deleting data`);
        }
      }
    }
  } catch (err) {
    console.warn(`⚠️ TTL index check: ${err.message}`);
  }
  await drop("attendances", "userId_1_stage_1_date_1_batchTime_1", "replaced by index that includes language");

  // Build the new indexes defined in the models
  for (const name of ["User", "Attendance", "Result", "Test"]) {
    try {
      await mongoose.model(name).syncIndexes();
    } catch (err) {
      console.warn(`⚠️ Index sync for ${name}: ${err.message}`);
    }
  }
};

mongoose.connection.on("error", (error) => console.error("❌ MongoDB error:", error.message));
mongoose.connection.on("disconnected", () => console.log("🔴 MongoDB disconnected"));

// =====================================================
// CRON JOBS (India time)
// =====================================================
const cronOptions = { timezone: "Asia/Kolkata", noOverlap: true };

// 20:15 IST — after the last batch (6:30–8:00 PM) has finished
const autoAbsentCron = cron.schedule(
  process.env.AUTO_ABSENT_CRON || "15 20 * * *",
  async () => {
    if (mongoose.connection.readyState !== 1) return;
    await autoMarkAbsent();
  },
  cronOptions
);

const monthlyFeeCron = cron.schedule(
  "0 0 1 * *",
  async () => {
    if (mongoose.connection.readyState !== 1) return;
    await resetMonthlyFeesForNewMonth();
  },
  cronOptions
);

// =====================================================
// START / SHUTDOWN
// =====================================================
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await connectDatabase();
    await runStartupMigrations();
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Let's Speak backend on port ${PORT} (timezone ${process.env.TZ})`);
    });
  } catch (error) {
    console.error("❌ Server startup failed:", error.message);
    process.exit(1);
  }
};

const shutdown = async () => {
  try {
    autoAbsentCron.stop();
    monthlyFeeCron.stop();
    io.close();
    server.close();
    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    process.exit(1);
  }
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (reason) => console.error("❌ UNHANDLED PROMISE REJECTION", reason));
process.on("uncaughtException", (error) => {
  console.error("❌ UNCAUGHT EXCEPTION", error);
  setTimeout(() => process.exit(1), 1000);
});

if (require.main === module) startServer();

const stopCrons = () => {
  autoAbsentCron.stop();
  monthlyFeeCron.stop();
};

module.exports = { app, server, io, startServer, runStartupMigrations, stopCrons };
