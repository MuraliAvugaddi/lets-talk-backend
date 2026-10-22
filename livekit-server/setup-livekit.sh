#!/usr/bin/env bash
# =====================================================================
# 🎧 Let's Speak — LiveKit audio server, ONE command setup (Ubuntu 22.04 / 24.04)
#
#   sudo bash setup-livekit.sh audio.yourdomain.com
#
# Before running: in your domain's DNS, add an "A record":
#   audio  →  <this server's IP address>
# At the end it prints LIVEKIT_URL / KEY / SECRET → put them on Render.
# =====================================================================
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "Usage: sudo bash setup-livekit.sh audio.yourdomain.com"; exit 1
fi
if [ "$(id -u)" != "0" ]; then echo "Run with sudo"; exit 1; fi

echo "▶ 1/6 Installing Docker…"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

echo "▶ 2/6 Network tuning for many audio streams…"
cat > /etc/sysctl.d/99-livekit.conf <<'SYS'
net.core.rmem_max=5000000
net.core.wmem_max=5000000
net.core.rmem_default=1000000
net.core.wmem_default=1000000
net.core.netdev_max_backlog=10000
fs.file-max=1000000
SYS
sysctl --system >/dev/null

echo "▶ 3/6 Firewall…"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 7881/tcp
  ufw allow 50000:60000/udp
  ufw --force enable
fi

echo "▶ 4/6 Keys + config…"
mkdir -p /opt/livekit
cd /opt/livekit
if [ ! -f keys.env ]; then
  KEY="API$(openssl rand -hex 6)"
  SECRET="$(openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | head -c 44)"
  printf 'KEY=%s\nSECRET=%s\n' "$KEY" "$SECRET" > keys.env
  chmod 600 keys.env
fi
. ./keys.env

cat > livekit.yaml <<YAML
port: 7880
bind_addresses: [""]
rtc:
  tcp_port: 7881              # fallback when Wi-Fi blocks UDP
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true
room:
  auto_create: false          # only a trainer (through our server) can start a class
  max_participants: 0         # no limit (principal class = everyone in one room)
  empty_timeout: 900
  departure_timeout: 300
# TURN is off: it needs its own TLS certificate setup. Students on networks that
# block UDP still connect over TCP port 7881 (rtc.tcp_port above).
turn:
  enabled: false
audio:
  update_interval: 1000       # "who is speaking" sent once a second (less traffic in a 2,000-person room)
keys:
  ${KEY}: ${SECRET}
logging:
  level: info
YAML

cat > Caddyfile <<CADDY
${DOMAIN} {
  reverse_proxy localhost:7880
}
CADDY

cat > docker-compose.yaml <<'COMPOSE'
services:
  livekit:
    image: livekit/livekit-server:v1.13.10   # tested version (update on purpose, not by surprise)
    command: --config /etc/livekit.yaml
    restart: unless-stopped
    network_mode: host
    ulimits:
      nofile: { soft: 1000000, hard: 1000000 }
    volumes:
      - ./livekit.yaml:/etc/livekit.yaml
  caddy:
    image: caddy:2
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
volumes:
  caddy_data:
COMPOSE

echo "▶ 5/6 Starting LiveKit + HTTPS…"
docker compose pull -q
docker compose up -d

echo "▶ 6/6 Checking…"
sleep 8
if curl -fsS "https://${DOMAIN}" >/dev/null 2>&1 || curl -fsS http://localhost:7880 >/dev/null 2>&1; then
  echo "✅ LiveKit is running"
else
  echo "⚠️  Not answering yet. Check: cd /opt/livekit && docker compose logs --tail 50"
fi

echo
echo "================ PUT THESE ON RENDER → Environment ================"
echo "LIVEKIT_URL=wss://${DOMAIN}"
echo "LIVEKIT_API_KEY=${KEY}"
echo "LIVEKIT_API_SECRET=${SECRET}"
echo "==================================================================="
echo "LIVE_PROVIDER=livekit  ← add this ONLY on switch day (after the new apps are in the stores)"
echo "(saved in /opt/livekit/keys.env — never put them on GitHub)"
