// =====================================================
// 🎧 LIVEKIT — our OWN audio-class server (replaces Stream, no per-minute bill)
//
// Render → Environment:
//   LIVE_PROVIDER=livekit                (stream = old apps / Stream, the default)
//   LIVEKIT_URL=wss://audio.yourdomain.com
//   LIVEKIT_API_KEY=...                  (from livekit.yaml on the audio server)
//   LIVEKIT_API_SECRET=...
//
// Rooms are named exactly like the old Stream calls
// (english_stage1_seca_class_20261021_v3 …), so attendance, merges,
// practice and the principal class all keep working unchanged.
// =====================================================
const { AccessToken, RoomServiceClient, TrackSource, TrackType } = require("livekit-server-sdk");

const isConfigured = () =>
  !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);

const provider = () => (String(process.env.LIVE_PROVIDER || "stream").toLowerCase() === "livekit" ? "livekit" : "stream");

// wss://audio.x.com → https://audio.x.com (server API uses HTTP)
const httpUrl = () => String(process.env.LIVEKIT_URL || "").replace(/^ws(s?):\/\//i, "http$1://");

let svc = null;
const rooms = () => {
  if (!isConfigured()) throw new Error("LiveKit is not set up (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET)");
  if (!svc) svc = new RoomServiceClient(httpUrl(), process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
  return svc;
};

// ---------- is the class live? (cached: 2,000 students = 1 request) ----------
const roomState = new Map(); // name → { started, at }
const inflight = new Map(); // name → Promise
const LIVE_TTL_MS = 10000;
const WAIT_TTL_MS = 4000;

const isRoomLive = async (name) => {
  const c = roomState.get(name);
  if (c && Date.now() - c.at < (c.started ? LIVE_TTL_MS : WAIT_TTL_MS)) return c.started;
  if (inflight.has(name)) return inflight.get(name);
  const p = (async () => {
    try {
      const list = await rooms().listRooms([name]);
      const started = Array.isArray(list) && list.some((r) => r.name === name);
      roomState.set(name, { started, at: Date.now() });
      return started;
    } finally {
      inflight.delete(name);
    }
  })();
  inflight.set(name, p);
  return p;
};

const markRoom = (name, started) => roomState.set(name, { started, at: Date.now() });

setInterval(() => {
  const old = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of roomState) if (v.at < old) roomState.delete(k);
}, 5 * 60 * 1000).unref();

// ---------- trainer / admin starts the class ----------
// A fresh classroom every start (mics open, no practice) — same as before.
const openRoom = async (name) => {
  await rooms().createRoom({
    name,
    emptyTimeout: 15 * 60, // nobody joined for 15 min → room closes
    departureTimeout: 5 * 60, // everyone left → closes after 5 min (a trainer's quick reconnect keeps it)
    maxParticipants: 0, // no limit
  });
  await rooms().updateRoomMetadata(name, "{}").catch(() => {});
  markRoom(name, true);
};

const closeRoom = async (name) => {
  markRoom(name, false);
  await rooms().deleteRoom(name).catch((e) => {
    if (!/not.?found/i.test(String(e && e.message))) throw e;
  });
};

// ---------- join token (one room, audio only) ----------
const joinToken = async ({ userId, name, room, staff }) => {
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity: String(userId),
    name: name || "User",
    metadata: JSON.stringify({ role: staff ? "admin" : "user" }), // apps read "admin" = trainer
    ttl: "6h",
  });
  at.addGrant({
    roomJoin: true,
    room,
    canSubscribe: true,
    canPublish: true,
    canPublishData: true,
    canPublishSources: [TrackSource.MICROPHONE], // 🎧 audio only — nobody can send video
    canUpdateOwnMetadata: false,
    roomAdmin: !!staff,
  });
  return at.toJwt();
};

// ---------- trainer controls ----------
const setRoomState = (room, custom) => rooms().updateRoomMetadata(room, JSON.stringify(custom || {}));

const removeUser = (room, identity) => rooms().removeParticipant(room, String(identity));

const muteAudioOf = async (room, info) => {
  const tracks = (info && info.tracks) || [];
  await Promise.all(
    tracks
      .filter((t) => t.type === TrackType.AUDIO && !t.muted)
      .map((t) => rooms().mutePublishedTrack(room, info.identity, t.sid, true).catch(() => {}))
  );
};

const muteUsers = async (room, identities) => {
  for (const id of identities) {
    const info = await rooms().getParticipant(room, String(id)).catch(() => null);
    if (info) await muteAudioOf(room, info);
  }
};

const muteAllExcept = async (room, keepIdentity) => {
  const list = await rooms().listParticipants(room);
  const talking = list.filter(
    (p) => p.identity !== String(keepIdentity) && (p.tracks || []).some((t) => t.type === TrackType.AUDIO && !t.muted)
  );
  await Promise.all(talking.map((p) => muteAudioOf(room, p)));
  return talking.length;
};

module.exports = {
  isConfigured,
  provider,
  isRoomLive,
  markRoom,
  openRoom,
  closeRoom,
  joinToken,
  setRoomState,
  removeUser,
  muteUsers,
  muteAllExcept,
  _internal: { roomState, setClient: (c) => (svc = c) },
};
