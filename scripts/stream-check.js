// =====================================================================
// 🔎 STREAM LIVE-CLASS CHECK
// Finds the REAL reason behind "connect cancelled" in the apps.
// It sends exactly the same "join class" request the apps send, but prints
// Stream's actual answer (the apps only show "connect cancelled").
//
// Run on the MacBook, inside the backend folder (backend can keep running):
//   node scripts/stream-check.js
//
// Optional (defaults = the ids from your screenshots, English stage1 section A):
//   node scripts/stream-check.js --trainer 6ad1a3e4f596d251242886af \
//        --student 6ad1c36988b736c836a264ad --language English --stage stage1 --section a
//
// It changes nothing in the database.
// =====================================================================
process.env.TZ = "Asia/Kolkata";
require("dotenv").config();

const { StreamClient } = require("@stream-io/node-sdk");
const { _internal } = require("../Controllers/UserContollers/streamController");

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const TRAINER = arg("trainer", "6ad1a3e4f596d251242886af");
const STUDENT = arg("student", "6ad1c36988b736c836a264ad");
const language = arg("language", "English");
const stage = arg("stage", "stage1");
const section = arg("section", "a");
const callType = "default";

const KEY = process.env.STREAM_API_KEY;
const SECRET = process.env.STREAM_API_SECRET;
const COORD = "https://video.stream-io-api.com/video"; // the URL the phone apps use

const line = () => console.log("─".repeat(70));
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => console.log(`  ❌ ${m}`);
const info = (m) => console.log(`  • ${m}`);
const findings = [];

const errText = (e) => {
  if (!e) return "unknown error";
  const code = e.metadata && e.metadata.responseCode;
  return `${code ? `HTTP ${code} ` : ""}${e.message || e}`;
};

async function locationHint() {
  try {
    const r = await fetch("https://hint.stream-io-video.com/", { method: "HEAD" });
    const pop = r.headers.get("x-amz-cf-pop") || "";
    return pop.slice(0, 3) || "ERR";
  } catch {
    return "ERR";
  }
}

async function clientRequest(method, path, token, body) {
  const url = `${COORD}${path}${path.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(KEY)}`;
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method,
      headers: {
        Authorization: token,
        "stream-auth-type": "jwt",
        "Content-Type": "application/json",
        "X-Stream-Client": "stream-video-check-script",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, json, text, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, json: null, text: String(e && e.cause ? e.cause : e), ms: Date.now() - t0 };
  }
}

async function testUser(client, label, userId, callId, location) {
  line();
  console.log(`👤 ${label}  (${userId})`);
  const iat = Math.floor(Date.now() / 1000) - 60;
  const token = client.generateUserToken({ user_id: userId, iat, exp: iat + 3600 });

  // 1) same as call.getOrCreate() in the app
  const g = await clientRequest("POST", `/call/${callType}/${callId}`, token, {});
  if (g.status === 200 || g.status === 201) ok(`App "load class" (getOrCreate) works  [${g.ms} ms]`);
  else {
    bad(`App "load class" (getOrCreate) FAILED → HTTP ${g.status}: ${(g.json && g.json.message) || g.text.slice(0, 300)}`);
    findings.push(`${label}: getOrCreate → ${(g.json && g.json.message) || g.status}`);
  }

  // 2) same as call.join() in the app (the step that shows "connect cancelled")
  const j = await clientRequest("POST", `/call/${callType}/${callId}/join`, token, { create: true, location });
  if (j.status !== 200 && j.status !== 201) {
    bad(`App "join class" FAILED → HTTP ${j.status}`);
    bad(`Stream says: ${(j.json && (j.json.message || j.json.detail)) || j.text.slice(0, 400)}`);
    findings.push(`${label}: join → HTTP ${j.status} ${(j.json && j.json.message) || ""}`);
    return;
  }
  ok(`App "join class" accepted by Stream  [${j.ms} ms]`);

  // 3) the audio server (SFU) the phone must reach next
  const sfu = j.json && j.json.credentials && j.json.credentials.server;
  if (!sfu) {
    bad("Join answer has no audio server (SFU) — unusual");
    findings.push(`${label}: no SFU in join answer`);
    return;
  }
  info(`Audio server: ${sfu.url}  (edge ${sfu.edge_name || "?"})`);
  info(`Audio websocket: ${sfu.ws_endpoint || "?"}`);
  const t0 = Date.now();
  try {
    const r = await fetch(sfu.url, { method: "GET" });
    ok(`Audio server reachable from this Mac (HTTP ${r.status}, ${Date.now() - t0} ms)`);
  } catch (e) {
    bad(`Audio server NOT reachable from this Mac: ${e && e.cause ? e.cause.code || e.cause.message : e}`);
    findings.push(`${label}: SFU ${sfu.url} unreachable from this network`);
  }
  const ice = (j.json.credentials.ice_servers || []).map((s) => (s.urls || []).join(" ")).join(" | ");
  if (ice) info(`TURN/ICE: ${ice.slice(0, 200)}`);
}

(async () => {
  console.log("\n🔎 Let's Speak — Stream live class check\n");
  if (!KEY || !SECRET) {
    bad("STREAM_API_KEY / STREAM_API_SECRET missing in .env");
    process.exit(1);
  }
  const client = new StreamClient(KEY, SECRET, { timeout: 15000 });
  const callId = _internal.buildCallId({ language, stage, section, type: "class" });

  info(`API key: ${KEY}`);
  info(`Today's call id: ${callId}`);
  info(`Mac clock: ${new Date().toString()}`);

  // ---------- Stream app ----------
  line();
  console.log("🏢 Stream app");
  try {
    const app = (await client.getApp()).app || {};
    ok("Secret is valid (server can talk to Stream)");
    for (const k of Object.keys(app)) {
      if (/suspend|disabled|revoke/i.test(k) && app[k]) {
        bad(`App setting ${k} = ${JSON.stringify(app[k])}`);
        findings.push(`app ${k} = ${JSON.stringify(app[k])}`);
      }
    }
  } catch (e) {
    bad(`Cannot read app: ${errText(e)}`);
    findings.push(`getApp → ${errText(e)}`);
  }

  // ---------- call type permissions ----------
  line();
  console.log(`📋 Call type "${callType}"`);
  try {
    const ct = await client.video.getCallType({ name: callType });
    const grants = ct.grants || {};
    for (const role of ["admin", "user", "call_member"]) {
      const g = grants[role] || [];
      const canJoin = g.includes("join-call");
      (canJoin ? ok : bad)(`role "${role}" can join: ${canJoin}   (${g.length} permissions)`);
      if (!canJoin && role !== "call_member") findings.push(`call type: role "${role}" has no join-call permission`);
    }
    const s = ct.settings || {};
    if (s.backstage && s.backstage.enabled) info("Backstage is ON for this call type (server calls goLive)");
    if (s.limits) info(`Limits: ${JSON.stringify(s.limits)}`);
  } catch (e) {
    bad(`Cannot read call type: ${errText(e)}`);
  }

  // ---------- today's call ----------
  line();
  console.log("📞 Today's call (created by the trainer's Start button)");
  try {
    const r = await client.video.call(callType, callId).get();
    const c = r.call || {};
    ok("Call exists");
    info(`created by: ${c.created_by && c.created_by.id}   created: ${c.created_at}`);
    if (c.ended_at) {
      bad(`Call is ENDED (${c.ended_at}) — nobody can join it again today`);
      findings.push("today's call is ended");
    }
    if (c.backstage) {
      bad("Call is in BACKSTAGE — students can't join until it goes live");
      findings.push("call is in backstage");
    }
    const blocked = c.blocked_user_ids || [];
    if (blocked.length) {
      bad(`Blocked users: ${blocked.join(", ")}`);
      if (blocked.includes(STUDENT)) findings.push("the student is BLOCKED in today's call");
      if (blocked.includes(TRAINER)) findings.push("the trainer is BLOCKED in today's call");
    }
    const sess = c.session;
    if (sess) info(`Session: ${sess.participants ? sess.participants.length : 0} connected, started ${sess.started_at || "-"}, ended ${sess.ended_at || "-"}`);
    if (c.settings && c.settings.limits) info(`Call limits: ${JSON.stringify(c.settings.limits)}`);
    info(`Custom data: ${JSON.stringify(c.custom || {})}`);
    const nulls = Object.entries(c.custom || {}).filter(([, v]) => v === null).map(([k]) => k);
    if (nulls.length) {
      bad(`Custom data has NULL values (${nulls.join(", ")}) — this crashes the apps' join`);
      findings.push(`call custom has null: ${nulls.join(", ")}`);
    }
  } catch (e) {
    const code = e && e.metadata && e.metadata.responseCode;
    if (code === 404) info("Call not created yet today (press Start on the trainer app first, then run again)");
    else bad(`Cannot read call: ${errText(e)}`);
  }

  // ---------- users ----------
  line();
  console.log("👥 Users in Stream");
  try {
    const r = await client.queryUsers({ payload: { filter_conditions: { id: { $in: [TRAINER, STUDENT] } } } });
    const users = r.users || [];
    for (const id of [TRAINER, STUDENT]) {
      const u = users.find((x) => x.id === id);
      if (!u) {
        bad(`${id}: not in Stream yet (opens the class page once to create it)`);
        continue;
      }
      ok(`${u.name || "?"} (${id}) role=${u.role}${u.banned ? " BANNED" : ""}${u.deactivated_at ? " DEACTIVATED" : ""}`);
      if (u.banned) findings.push(`${u.name} is banned in Stream`);
      if (u.deactivated_at) findings.push(`${u.name} is deactivated in Stream`);
      if (u.revoke_tokens_issued_before) {
        bad(`   tokens revoked before ${u.revoke_tokens_issued_before}`);
        findings.push(`${u.name}: tokens revoked before ${u.revoke_tokens_issued_before}`);
      }
    }
  } catch (e) {
    bad(`Cannot read users: ${errText(e)}`);
  }

  // ---------- the real join test ----------
  const location = await locationHint();
  line();
  info(`Location hint: ${location}`);
  await testUser(client, "TRAINER", TRAINER, callId, location);
  await testUser(client, "STUDENT", STUDENT, callId, location);

  line();
  console.log("\n📌 RESULT");
  if (!findings.length) {
    console.log("  Stream accepts both joins and the audio server is reachable.");
    console.log("  → The problem is inside the app (Stream package / web audio). Send this output + pubspec.lock line.");
  } else {
    for (const f of findings) console.log(`  ❗ ${f}`);
  }
  console.log("\nCopy everything above and send it.\n");
  process.exit(0);
})().catch((e) => {
  console.error("Script error:", e);
  process.exit(1);
});
