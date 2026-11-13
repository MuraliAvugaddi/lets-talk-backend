// ⚡ Short memory of logged-in accounts (used by the auth middleware).
// Any change to a user in the database removes it from here at once
// (hooks in Models/users.js), so access / section / logout changes are never late.
const TTL_MS = 15000;
const cache = new Map(); // id → { user, at }

const get = (id) => {
  const hit = cache.get(id);
  return hit && Date.now() - hit.at < TTL_MS ? hit.user : null;
};
const set = (id, user) => {
  if (cache.size > 20000) cache.clear(); // keep memory small
  cache.set(id, { user, at: Date.now() });
};
// tell every backend worker (multi-core mode) — see utils/clusterBus.js
const bus = require("./clusterBus");
bus.on("userCache.forget", (id) => (id ? cache.delete(String(id)) : cache.clear()));
const forget = (id) => bus.publish("userCache.forget", id ? String(id) : null);
const clearAll = () => bus.publish("userCache.forget", null);

setInterval(() => {
  const old = Date.now() - TTL_MS;
  for (const [k, v] of cache) if (v.at < old) cache.delete(k);
}, 60000).unref();

module.exports = { get, set, forget, clearAll, TTL_MS };
