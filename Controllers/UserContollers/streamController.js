const { StreamClient } = require("@stream-io/node-sdk");

const apiKey = "urzyyp7kctqv";
const apiSecret = "es8x7cf6ym5snt3n98ek2zta49r5yrrfb59f47uwzp6y3c7cc36mkzpswd2pxdk8";

// 🚀 Singleton client caching for high-concurrency performance
let cachedStreamClient = null;
const getStreamClient = () => {
  if (!cachedStreamClient) {
    cachedStreamClient = new StreamClient(apiKey, apiSecret);
  }
  return cachedStreamClient;
};

const getStreamToken = async (req, res) => {
  try {
    const { userId, name, role } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const client = getStreamClient();
    // Ensure teachers get admin/call-moderator capabilities
    const userRole = role === "admin" ? "admin" : "user";

    const token = client.generateUserToken({
      user_id: userId.toString(),
      validity_in_seconds: 86400,
    });

    // 🚀 Non-blocking upsert to eliminate latency on massive concurrent joins
    client.upsertUsers([
      {
        id: userId.toString(),
        name: name || "User",
        role: userRole,
      },
    ]).catch((err) => console.error("Background user upsert warning:", err));

    res.status(200).json({ token, userId, role: userRole });
  } catch (error) {
    console.error("Error generating Stream token:", error);
    res.status(500).json({ error: error.message });
  }
};

module.exports = { getStreamToken };