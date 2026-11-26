// ⚡ The Socket.IO server, for code that has no "req" (background notifications).
// index.js calls set(io) once at start. get() is null in tests → nothing is sent.
let io = null;
module.exports = {
  set: (x) => {
    io = x;
  },
  get: () => io,
};
