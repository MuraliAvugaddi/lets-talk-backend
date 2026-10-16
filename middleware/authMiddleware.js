// =====================================================
// AUTH MIDDLEWARE
//
// requireAuth(...roles)  → token ALWAYS required (+ role check if roles given)
// auth(...roles)         → transition mode:
//      • token present  → verified, role enforced
//      • no token       → allowed only while ENFORCE_AUTH !== "true"
//   Flip ENFORCE_AUTH=true on Render once all three apps send tokens.
// =====================================================

const jwt = require("jsonwebtoken");
const User = require("../Models/users");

const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET missing or too short (use 32+ random characters)");
  }
  return secret;
};

const signToken = (user) =>
  jwt.sign({ id: String(user._id), role: user.role }, getJwtSecret(), {
    expiresIn: process.env.JWT_EXPIRES_IN || "90d",
  });

const readBearer = (req) => {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
};

// Resolves the user from the token. Returns { user } or { error, status }.
const resolveUser = async (token) => {
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    const user = await User.findById(decoded.id).select("-password").lean();
    if (!user) return { status: 401, error: { message: "User not found" } };

    if (decoded.sessionToken && user.sessionToken !== decoded.sessionToken) {
      return {
        status: 401,
        error: {
          code: "SESSION_EXPIRED",
          message: "You have been logged out because your account was accessed from another device.",
        },
      };
    }
    return { user };
  } catch (err) {
    return { status: 401, error: { message: "Not authorized, token failed" } };
  }
};

const roleAllowed = (user, roles) => roles.length === 0 || roles.includes(user.role);

let lastCompatWarning = 0;
const warnCompat = (req) => {
  // At most one log line per minute so logs stay readable
  const now = Date.now();
  if (now - lastCompatWarning > 60000) {
    lastCompatWarning = now;
    console.warn(`⚠️ Unauthenticated call allowed (ENFORCE_AUTH off): ${req.method} ${req.originalUrl}`);
  }
};

const requireAuth = (...roles) => async (req, res, next) => {
  const token = readBearer(req);
  if (!token) return res.status(401).json({ message: "Not authorized, no token" });

  const { user, error, status } = await resolveUser(token);
  if (error) return res.status(status).json(error);
  if (!roleAllowed(user, roles)) return res.status(403).json({ message: "Forbidden" });

  req.user = user;
  next();
};

const auth = (...roles) => async (req, res, next) => {
  const token = readBearer(req);

  if (!token) {
    if (process.env.ENFORCE_AUTH === "true") {
      return res.status(401).json({ message: "Not authorized, no token" });
    }
    warnCompat(req);
    req.user = null;
    return next();
  }

  const { user, error, status } = await resolveUser(token);
  if (error) return res.status(status).json(error);
  if (!roleAllowed(user, roles)) return res.status(403).json({ message: "Forbidden" });

  req.user = user;
  next();
};

// Old name kept so nothing else breaks
const protect = requireAuth();

module.exports = { auth, requireAuth, protect, signToken, resolveUser, readBearer, getJwtSecret };
