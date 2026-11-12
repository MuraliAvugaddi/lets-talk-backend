// 🧪 Fake LiveKit room API — ONLY for testing the backend on a laptop without
// an audio server. (Real audio load is tested with `lk load-test`, see livekit-server/load-test.md)
//   node scripts/loadtest/livekit-stub.js   → http://localhost:7880
const http = require("http");
const rooms = new Map();
const calls = {};
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const method = (req.url.split("/").pop() || "").trim();
      calls[method] = (calls[method] || 0) + 1;
      let data = {};
      try {
        data = JSON.parse(body || "{}");
      } catch (_) {}
      let out = {};
      if (method === "CreateRoom") {
        rooms.set(data.name, { name: data.name, numParticipants: 0, creationTime: String(Math.floor(Date.now() / 1000)) });
        out = rooms.get(data.name);
      } else if (method === "ListRooms") {
        const names = data.names || [];
        out = { rooms: [...rooms.values()].filter((r) => !names.length || names.includes(r.name)) };
      } else if (method === "DeleteRoom") {
        rooms.delete(data.room);
      } else if (method === "UpdateRoomMetadata") {
        out = rooms.get(data.room) || {};
      } else if (method === "ListParticipants") {
        out = { participants: [] };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  })
  .listen(Number(process.env.STUB_PORT || 7880), () => console.log("fake LiveKit API on :7880"));
setInterval(() => console.log("LiveKit API calls so far:", JSON.stringify(calls)), 30000).unref();
