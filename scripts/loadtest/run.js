// =====================================================================
// 🧪 LOAD TEST — step 2: 2,000 students hit the backend like a real class
//
//   BASE=http://localhost:5001 node scripts/loadtest/run.js
//
// Options (env):
//   JOIN_WINDOW=60     students arrive over this many seconds (real class start)
//   SYNC_MINUTES=2     how long everyone stays in class (1 sync per minute each)
//   SOCKETS=1          also open one live socket per student (like the app)
//   ASSEMBLY=1         also test the special class (all students in ~6 s)
//   ONLY=B             run only the special-class test (ONLY=A → only the normal class)
//
// Uses scripts/loadtest/accounts.json from seed.js. Prints p50 / p95 / p99 per API.
// =====================================================================
const fs = require("fs");
const path = require("path");

const BASE = (process.env.BASE || "http://localhost:5001").replace(/\/$/, "");
const JOIN_WINDOW = Number(process.env.JOIN_WINDOW || 60);
const SYNC_MINUTES = Number(process.env.SYNC_MINUTES || 2);
const SOCKETS = process.env.SOCKETS !== "0";
const ASSEMBLY = process.env.ASSEMBLY !== "0";

const accounts = JSON.parse(fs.readFileSync(process.env.ACCOUNTS_FILE || path.join(__dirname, "accounts.json"), "utf8"));
const students = accounts.filter((a) => a.role === "student");
const trainers = accounts.filter((a) => a.role === "teacher");
const admin = accounts.find((a) => a.role === "admin");

// ---------------- metrics ----------------
const stats = new Map(); // name → { ms: [], codes: {} }
const rec = (name, ms, code) => {
  const s = stats.get(name) || { ms: [], codes: {} };
  s.ms.push(ms);
  s.codes[code] = (s.codes[code] || 0) + 1;
  stats.set(name, s);
};
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
};
const report = (title) => {
  console.log(`\n=== ${title} ===`);
  console.log("API".padEnd(34), "count".padStart(6), "p50".padStart(7), "p95".padStart(7), "p99".padStart(7), "max".padStart(7), "  status codes");
  for (const [name, s] of stats) {
    console.log(
      name.padEnd(34),
      String(s.ms.length).padStart(6),
      `${pct(s.ms, 50)}`.padStart(7),
      `${pct(s.ms, 95)}`.padStart(7),
      `${pct(s.ms, 99)}`.padStart(7),
      `${Math.max(...s.ms)}`.padStart(7),
      " ",
      JSON.stringify(s.codes)
    );
  }
  stats.clear();
};

// plain http with keep-alive (lighter than fetch → the test machine itself is not the bottleneck)
const http = require(BASE.startsWith("https") ? "https" : "http");
const agent = new http.Agent({ keepAlive: true, maxSockets: Number(process.env.MAX_SOCKETS || 256) });
const call = (name, method, url, token, body) =>
  new Promise((resolve) => {
    const t = Date.now();
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      `${BASE}${url}`,
      {
        method,
        agent,
        timeout: 30000,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          rec(name, Date.now() - t, res.statusCode);
          let data = {};
          try {
            data = JSON.parse(text);
          } catch (_) {}
          resolve({ status: res.statusCode, data });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => {
      rec(name, Date.now() - t, e.message === "timeout" ? "timeout" : "neterr");
      resolve({ status: 0, data: {} });
    });
    if (payload) req.write(payload);
    req.end();
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lagProbe = () => {
  // how slow is the SERVER answering a tiny request right now
  const t = Date.now();
  return call("(health check)", "GET", "/", "x").then((r) => (r.status ? Date.now() - t : -1));
};

// ---------------- sockets (like the apps) ----------------
const openSockets = async () => {
  let io;
  try {
    io = require("socket.io-client");
  } catch (_) {
    console.log("⚠️ socket.io-client not installed → skipping sockets (npm i --no-save socket.io-client)");
    return [];
  }
  const t = Date.now();
  const list = [];
  let ok = 0;
  await Promise.all(
    students.map(
      (s, i) =>
        new Promise((resolve) => {
          setTimeout(() => {
            const sock = io(BASE, { transports: ["websocket"], auth: { token: s.token }, reconnection: true });
            sock.on("connect", () => {
              ok++;
              sock.emit("join_user_room", s.id);
              resolve();
            });
            sock.on("connect_error", () => resolve());
            setTimeout(resolve, 20000);
            list.push(sock);
          }, (i % 200) * 10);
        })
    )
  );
  console.log(`🔌 Sockets connected: ${ok}/${students.length} in ${Date.now() - t} ms`);
  return list;
};

// ---------------- scenario A: normal class start ----------------
const studentFlow = async (s) => {
  await call("GET class-mode", "GET", "/api/class-mode", s.token);
  await call("GET my-attendance", "GET", `/api/user/my-attendance?userId=${s.id}`, s.token);
  const prep = await call("POST rtc/prepare-call", "POST", "/api/rtc/prepare-call", s.token, {
    language: s.language,
    stage: s.stage,
    section: s.section,
    type: "class",
  });
  const room = prep.data && prep.data.callId;
  if (room) await call("POST rtc/room-token", "POST", "/api/rtc/room-token", s.token, { room });
  const join = await call("POST join-online-class", "POST", "/api/user/join-online-class", s.token, {
    language: s.language,
    stage: s.stage,
  });
  return join.data && join.data.attendanceId;
};

const scenarioClass = async () => {
  console.log(`\n▶ Scenario A: ${trainers.length} trainers start, ${students.length} students join within ${JOIN_WINDOW}s, stay ${SYNC_MINUTES} min`);
  await Promise.all(
    trainers.map((t) =>
      call("POST rtc/prepare-call (trainer)", "POST", "/api/rtc/prepare-call", t.token, {
        language: t.language,
        stage: t.stage,
        section: t.section,
        type: "class",
      })
    )
  );

  // admin keeps the dashboards open meanwhile (like a real admin)
  let adminOn = true;
  const adminLoop = (async () => {
    while (adminOn) {
      await call("GET admin all-students", "GET", "/api/admin/all-students?mode=all&language=all&stage=all", admin.token);
      await call("GET admin live-rooms", "GET", "/api/rtc/live-rooms", admin.token);
      await sleep(10000);
    }
  })();

  const lags = [];
  const lagLoop = setInterval(async () => lags.push(await lagProbe()), 1000);

  const t0 = Date.now();
  const ids = await Promise.all(
    students.map(async (s) => {
      await sleep(Math.random() * JOIN_WINDOW * 1000);
      return studentFlow(s);
    })
  );
  console.log(`   all joined in ${((Date.now() - t0) / 1000).toFixed(1)} s · attendance ids: ${ids.filter(Boolean).length}/${students.length}`);
  report("A1 · class start rush");

  // in class: every phone syncs once a minute
  const syncEnd = Date.now() + SYNC_MINUTES * 60000;
  await Promise.all(
    students.map(async (s, i) => {
      const id = ids[i];
      if (!id) return;
      await sleep(Math.random() * 60000);
      while (Date.now() < syncEnd) {
        await call("POST sync-online-class", "POST", "/api/user/sync-online-class", s.token, { attendanceId: id });
        await sleep(60000);
      }
    })
  );
  adminOn = false;
  await adminLoop;
  clearInterval(lagLoop);
  report(`A2 · ${SYNC_MINUTES} min in class (syncs + admin screens)`);
  console.log(`   tiny-request response time during A: p50 ${pct(lags, 50)} ms · p95 ${pct(lags, 95)} ms · max ${Math.max(...lags)} ms`);

  // everyone leaves
  await Promise.all(
    students.map(async (s, i) => {
      if (!ids[i]) return;
      await sleep(Math.random() * 10000);
      await call("POST leave-online-class", "POST", "/api/user/leave-online-class", s.token, { attendanceId: ids[i] });
    })
  );
  report("A3 · class end");
};

// ---------------- scenario B: special class (everyone in ONE room) ----------------
const scenarioAssembly = async () => {
  console.log(`\n▶ Scenario B: special class — ${students.length} students join within ~6 s`);
  await call("POST class-mode/assembly ON", "POST", "/api/class-mode/assembly", admin.token, {
    active: true,
    title: "Load test special class",
    startTime: "11:00 AM",
  });
  await sleep(1500);
  await call("POST rtc/prepare-call (host)", "POST", "/api/rtc/prepare-call", admin.token, { type: "assembly" });
  const t0 = Date.now();
  await Promise.all(
    students.map(async (s) => {
      await sleep(300 + Math.random() * 6000); // same random spread as the student app
      const prep = await call("POST rtc/prepare-call (assembly)", "POST", "/api/rtc/prepare-call", s.token, { type: "assembly" });
      const room = prep.data && prep.data.callId;
      if (room && prep.data.started) await call("POST rtc/room-token (assembly)", "POST", "/api/rtc/room-token", s.token, { room });
      await call("POST join-online-class (assembly)", "POST", "/api/user/join-online-class", s.token, {
        language: s.language,
        stage: s.stage,
        assembly: true,
      });
    })
  );
  console.log(`   all joined in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await call("POST class-mode/assembly OFF", "POST", "/api/class-mode/assembly", admin.token, { active: false });
  report("B · special class burst");
};

(async () => {
  console.log(`🎯 ${BASE} · ${students.length} students · ${trainers.length} trainers`);
  const lag0 = await lagProbe();
  if (lag0 < 0) {
    console.error("❌ Server not reachable");
    process.exit(1);
  }
  const socks = SOCKETS ? await openSockets() : [];
  if (process.env.ONLY !== "B") await scenarioClass();
  if (ASSEMBLY && process.env.ONLY !== "A") await scenarioAssembly();
  socks.forEach((s) => s.close());
  console.log("\n✅ Done");
  process.exit(0);
})();
