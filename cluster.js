// =====================================================================
// 🧩 MULTI-CORE START — runs the backend on several CPU cores
//
//   node cluster.js            (server)    → up to 4 workers (leaves 2 cores for MongoDB + Caddy)
//   WEB_CONCURRENCY=3 node cluster.js       → exactly 3 workers
//   node index.js              (laptop)    → one process, same as before
//
// Why: Node.js uses only ONE core. When 2,000 students join at the same
// moment, one core is full while the others sit idle. Here every worker is
// a full copy of the backend; Linux shares the students between them.
//
// • Live messages (sockets) reach students on every worker  → @socket.io/cluster-adapter
// • Daily jobs (auto-absent, reminders …) run in ONE worker only (the "leader")
// • Small memories (login, class mode, live rooms) stay in sync → utils/clusterBus.js
// • A crashed worker is restarted automatically
// =====================================================================
process.env.TZ = "Asia/Kolkata";

const cluster = require("cluster");
const os = require("os");

if (!cluster.isPrimary) {
  require("./index").startServer();
} else {
  const { setupPrimary } = require("@socket.io/cluster-adapter");
  setupPrimary(); // relays socket messages between workers

  const cores = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  const count = Math.max(1, Number(process.env.WEB_CONCURRENCY) || Math.min(4, cores - 2));
  console.log(`🧩 Starting ${count} backend workers (${cores} CPU cores)`);

  let leaderId = null;
  let stopping = false;

  const fork = (leader) => {
    const w = cluster.fork({ CRON_LEADER: leader ? "1" : "0" });
    if (leader) leaderId = w.id;
    return w;
  };
  for (let i = 0; i < count; i++) fork(i === 0);

  // a worker changed something → tell all the other workers (utils/clusterBus.js)
  cluster.on("message", (from, msg) => {
    if (!msg || !msg.__bus) return;
    for (const id in cluster.workers) {
      const w = cluster.workers[id];
      if (w && w.id !== from.id && w.isConnected()) {
        try {
          w.send(msg);
        } catch (_) {}
      }
    }
  });

  // crashed worker → start a new one (the leader stays the leader)
  cluster.on("exit", (w, code, signal) => {
    if (stopping) return;
    const wasLeader = w.id === leaderId;
    console.error(`⚠️ Worker ${w.process.pid} stopped (${signal || code}) → starting a new one${wasLeader ? " (leader)" : ""}`);
    setTimeout(() => fork(wasLeader), 1000);
  });

  const stopAll = () => {
    stopping = true;
    for (const id in cluster.workers) cluster.workers[id].process.kill("SIGTERM");
    setTimeout(() => process.exit(0), 8000).unref();
    cluster.on("exit", () => {
      if (!Object.keys(cluster.workers).length) process.exit(0);
    });
  };
  process.on("SIGTERM", stopAll);
  process.on("SIGINT", stopAll);
}
