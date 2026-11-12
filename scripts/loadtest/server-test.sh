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
  docker rm -f lt-api >/dev/null 2>&1 || true
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
  node:22-bookworm-slim sh -c "node scripts/loadtest/livekit-stub.js >/dev/null & exec node index.js" >/dev/null
sleep 8
docker logs lt-api 2>&1 | tail -4

echo "▶ Creating $N test students…"
docker exec lt-api node scripts/loadtest/seed.js "$N"

echo "▶ Running the test (about 5 minutes)…"
docker exec -e BASE=http://127.0.0.1:5099 -e SOCKETS=0 -e MAX_SOCKETS=2000 lt-api node scripts/loadtest/run.js
