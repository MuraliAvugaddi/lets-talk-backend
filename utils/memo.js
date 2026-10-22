// ⚡ Small in-memory cache for heavy reports (leaderboards, best students).
// 300 students opening the leaderboard together → computed ONCE, not 300 times.
const store = new Map(); // key → { at, value }
const inflight = new Map(); // key → Promise

const memo = async (key, ttlMs, compute) => {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const value = await compute();
      store.set(key, { at: Date.now(), value });
      if (store.size > 200) store.delete(store.keys().next().value); // keep memory small
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
};

const clearMemo = () => store.clear();

module.exports = { memo, clearMemo };
