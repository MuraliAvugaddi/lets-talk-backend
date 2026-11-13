// =====================================================================
// 🧩 Tiny message bus between backend workers (multi-core mode, cluster.js)
//
// Each worker keeps small memories (logged-in users, class mode, live rooms…).
// When one worker changes something, publish() tells ALL workers at once,
// so nobody keeps an old answer. With one process (laptop / tests) it simply
// runs the handler locally.
// =====================================================================
const cluster = require("cluster");

const handlers = new Map(); // type → fn(payload)
const run = (type, payload) => {
  const fn = handlers.get(type);
  if (!fn) return;
  try {
    fn(payload);
  } catch (_) {}
};

const on = (type, fn) => handlers.set(type, fn);

const publish = (type, payload) => {
  run(type, payload); // this worker
  if (cluster.isWorker && typeof process.send === "function") {
    try {
      process.send({ __bus: true, type, payload, from: process.pid }); // the others (via cluster.js)
    } catch (_) {}
  }
};

if (cluster.isWorker) {
  process.on("message", (m) => {
    if (m && m.__bus && m.from !== process.pid) run(m.type, m.payload);
  });
}

module.exports = { on, publish };
