// =====================================================
// STREAM BATCHING — so 2,000–2,500 students can join the special class at the
// same moment without hitting Stream's API rate limits.
//
// Instead of 1 Stream API call per student, requests that arrive within
// ~250 ms are sent together (up to 100 per call):
//   ensureUser(client, {id, name, role})   → upsertUsers([...100 users])
//   addMember(call, callId, userId)        → updateCallMembers([...100 members])
// =====================================================
const FLUSH_MS = 250;
const MAX_BATCH = 100;

const knownUsers = new Map(); // id → "role|name" already pushed to Stream

// ---------- users ----------
const pendingUsers = new Map(); // id → { user, waiters: [] }
let userTimer = null;

const flushUsers = async (client) => {
  userTimer = null;
  const batch = [...pendingUsers.values()].slice(0, MAX_BATCH);
  batch.forEach((p) => pendingUsers.delete(p.user.id));
  if (pendingUsers.size) userTimer = setTimeout(() => flushUsers(client), 0);
  try {
    await client.upsertUsers(batch.map((p) => p.user));
    batch.forEach((p) => {
      knownUsers.set(p.user.id, `${p.user.role}|${p.user.name}`);
      p.waiters.forEach((w) => w.resolve());
    });
  } catch (e) {
    batch.forEach((p) => p.waiters.forEach((w) => w.reject(e)));
  }
};

const ensureUser = (client, user) => {
  const sig = `${user.role}|${user.name}`;
  if (knownUsers.get(user.id) === sig) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = pendingUsers.get(user.id);
    if (existing) {
      existing.user = user;
      existing.waiters.push({ resolve, reject });
    } else {
      pendingUsers.set(user.id, { user, waiters: [{ resolve, reject }] });
    }
    if (pendingUsers.size >= MAX_BATCH) {
      clearTimeout(userTimer);
      flushUsers(client);
    } else if (!userTimer) {
      userTimer = setTimeout(() => flushUsers(client), FLUSH_MS);
    }
  });
};

// ---------- call members ----------
const pendingMembers = new Map(); // callId → { call, ids: Map(id → waiters[]), timer }
const memberOk = new Map(); // `${callId}|${userId}` → true

const flushMembers = async (callId) => {
  const group = pendingMembers.get(callId);
  if (!group) return;
  group.timer = null;
  const ids = [...group.ids.keys()].slice(0, MAX_BATCH);
  const waiters = ids.map((id) => group.ids.get(id));
  ids.forEach((id) => group.ids.delete(id));
  if (group.ids.size) group.timer = setTimeout(() => flushMembers(callId), 0);
  else pendingMembers.delete(callId);

  let error = null;
  try {
    await group.call.updateCallMembers({ update_members: ids.map((user_id) => ({ user_id, role: "call_member" })) });
    ids.forEach((id) => memberOk.set(`${callId}|${id}`, true));
  } catch (e) {
    error = (e && e.message) || String(e);
    console.error("Add call members error:", error);
  }
  waiters.forEach((list) => list.forEach((resolve) => resolve(error)));
};

/** Resolves with null (ok) or an error text — never throws (joining may still work). */
const addMember = (call, callId, userId) => {
  if (memberOk.get(`${callId}|${userId}`)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let group = pendingMembers.get(callId);
    if (!group) {
      group = { call, ids: new Map(), timer: null };
      pendingMembers.set(callId, group);
    }
    const list = group.ids.get(userId) || [];
    list.push(resolve);
    group.ids.set(userId, list);
    if (group.ids.size >= MAX_BATCH) {
      clearTimeout(group.timer);
      flushMembers(callId);
    } else if (!group.timer) {
      group.timer = setTimeout(() => flushMembers(callId), FLUSH_MS);
    }
  });
};

// keep memory small: forget member marks of old days (call ids contain the date)
setInterval(() => {
  if (memberOk.size > 50000) memberOk.clear();
}, 60 * 60 * 1000).unref();

module.exports = { ensureUser, addMember, knownUsers, _internal: { pendingUsers, pendingMembers } };
