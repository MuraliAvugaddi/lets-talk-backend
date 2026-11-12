#!/usr/bin/env bash
# =====================================================================
# 🧪 2,000-student load test ON THE API SERVER — safe for live data
#
#   bash /opt/letsspeak/app/scripts/loadtest/server-test.sh 2000
#
# • Starts a SECOND, private copy of the backend (port 5099, not public)
# • Uses a separate database "lets_talk_loadtest" — real students are never touched
# • No push notifications, no SMS, no real audio rooms (a fake LiveKit API is used)
# • Deletes the test database and the test copy at the end
# Run it when no class is running (it shares the database server with the live app).
# =====================================================================
set -euo pipefail
N="${1:-2000}"
cd /opt/letsspeak
set -a; . ./db.env; set +a
TEST_URI="mongodb://${MONGO_USER}:${MONGO_PASS}@letsspeak-mongo:27017/lets_talk_loadtest?authSource=admin"

cleanup() {
  echo "🧹 Cleaning up…"
  docker exec lt-api node scripts/loadtest/cleanup.js 2>/dev/null || true
  # 🔬 stop the test backend gently so it writes its CPU profile, then show the top of it
  docker exec lt-api sh -c 'kill -INT 1' 2>/dev/null || true
  sleep 4
  docker cp lt-api:/tmp/prof /tmp/lt-prof >/dev/null 2>&1 || true
  docker rm -f lt-api >/dev/null 2>&1 || true
  PROF=$(ls -t /tmp/lt-prof/*.cpuprofile 2>/dev/null | head -1 || true)
  if [ -n "$PROF" ]; then
    docker run --rm -v /opt/letsspeak/app:/app:ro -v /tmp/lt-prof:/prof:ro -w /app node:22-bookworm-slim \
      node scripts/loadtest/profile-top.js "/prof/$(basename "$PROF")" || true
    rm -rf /tmp/lt-prof
  fi
}
trap cleanup EXIT

docker rm -f lt-api >/dev/null 2>&1 || true
echo "▶ Starting the test copy of the backend…"
docker run -d --name lt-api --network letsspeak_db \
  -v /opt/letsspeak/app:/app:ro -w /app \
  --env-file api.env \
  -e MONGO_URI="$TEST_URI" \
  -e PORT=5099 -e NODE_ENV=production \
  -e LIVE_PROVIDER=livekit -e LIVEKIT_URL=ws://127.0.0.1:7880 \
  -e LIVEKIT_API_KEY=loadtest -e LIVEKIT_API_SECRET=loadtest_loadtest_loadtest_loadtest \
  -e STREAM_CALL_VERSION=loadtest \
  -e FIREBASE_SERVICE_ACCOUNT_BASE64= -e FIREBASE_PROJECT_ID= -e MC_PASSWORD= -e MSG91_AUTH_KEY= \
  -e ENFORCE_AUTH=true -e ENFORCE_BATCH_WINDOW=false \
  -e ACCOUNTS_FILE=/tmp/accounts.json \
  node:22-bookworm-slim sh -c "node scripts/loadtest/livekit-stub.js >/dev/null & exec node --cpu-prof --cpu-prof-dir=/tmp/prof index.js" >/dev/null
sleep 8
docker logs lt-api 2>&1 | tail -4

echo "▶ Creating $N test students…"
docker exec lt-api node scripts/loadtest/seed.js "$N"

# 📈 record CPU use of the whole server during the test (no second window needed)
vmstat 2 > /tmp/lt-vmstat.txt &
VMSTAT_PID=$!
( sleep 45; echo; echo "📦 Containers 45 s into the test:"; docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" ) &

echo "▶ Speed of ONE request when the server is quiet (should be a few ms):"
docker exec lt-api node -e '
const http=require("http");const a=JSON.parse(require("fs").readFileSync("/tmp/accounts.json"));
const s=a.find(x=>x.role==="student");const ag=new http.Agent({keepAlive:true,maxSockets:1});
const one=(p)=>new Promise(r=>{const t=process.hrtime.bigint();http.get("http://127.0.0.1:5099"+p,{agent:ag,headers:{Authorization:"Bearer "+s.token}},res=>{res.resume();res.on("end",()=>r(Number(process.hrtime.bigint()-t)/1e6))}).on("error",()=>r(-1))});
(async()=>{for(const p of ["/","/api/class-mode","/api/user/my-attendance?userId="+s.id]){const ms=[];for(let i=0;i<200;i++)ms.push(await one(p));ms.sort((x,y)=>x-y);console.log("   "+p.split("?")[0].padEnd(28)+" typical "+ms[100].toFixed(1)+" ms")}process.exit(0)})()' || true

echo "▶ Running the test (about 5 minutes)…"
# MAX_SOCKETS=200: like Caddy, which keeps a small set of connections to the backend
docker exec -e BASE=http://127.0.0.1:5099 -e SOCKETS=0 -e MAX_SOCKETS="${MAX_SOCKETS:-200}" lt-api node scripts/loadtest/run.js || true

kill $VMSTAT_PID 2>/dev/null || true
echo
echo "📈 Server CPU during the test (%):  user  system  idle  disk-wait  steal"
awk 'NR>2 && $13 ~ /^[0-9]+$/ { n++; us+=$13; sy+=$14; id+=$15; wa+=$16; st+=$17;
       if ($15 < minid || n==1) minid=$15; if ($17 > maxst) maxst=$17 }
     END { if (n) printf "   average:                         %4.0f  %6.0f  %4.0f  %9.0f  %5.0f\n   busiest moment: idle %d%%, worst steal %d%%\n", us/n, sy/n, id/n, wa/n, st/n, minid, maxst }' /tmp/lt-vmstat.txt
