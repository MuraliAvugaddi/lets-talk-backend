#!/usr/bin/env bash
# =====================================================================
# 📶 Turn ON TURN in LiveKit — classes keep working on weak / strict networks
#
#   cd /opt/livekit && sudo bash enable-turn.sh
#
# WHY: on Jio / Airtel 4G with a weak signal, office or college Wi-Fi, some
# phones cannot send voice over the normal UDP ports (50000–60000), and the
# backup TCP port 7881 is blocked on many networks. Then the class keeps
# "reconnecting" even though the phone still has 5–10 Mbps.
# TURN gives those phones two more ways in:
#   • UDP 3478          (works on most mobile data)
#   • TLS 5349          (looks like normal HTTPS traffic → passes almost every firewall)
# Phones with a good network keep using the direct way — nothing changes for them.
#
# Safe to run again. Makes a backup first. Run it when NO class is running
# (LiveKit restarts for ~5 seconds).
# =====================================================================
set -euo pipefail
cd /opt/livekit

[ -f livekit.yaml ] || { echo "❌ /opt/livekit/livekit.yaml not found"; exit 1; }
[ -f Caddyfile ] || { echo "❌ /opt/livekit/Caddyfile not found"; exit 1; }
DOMAIN=$(awk 'NF && $1 !~ /^#/ {print $1; exit}' Caddyfile)
[ -n "$DOMAIN" ] || { echo "❌ could not read the domain from Caddyfile"; exit 1; }
echo "▶ LiveKit domain: $DOMAIN"

STAMP=$(date +%Y%m%d_%H%M)
cp livekit.yaml "livekit.yaml.bak_$STAMP"
cp docker-compose.yaml "docker-compose.yaml.bak_$STAMP"
echo "▶ Backups: livekit.yaml.bak_$STAMP, docker-compose.yaml.bak_$STAMP"

# Caddy already has a free HTTPS certificate for the domain → TURN uses the same one
CERT="/caddy/caddy/certificates/acme-v02.api.letsencrypt.org-directory/${DOMAIN}/${DOMAIN}.crt"
KEY="/caddy/caddy/certificates/acme-v02.api.letsencrypt.org-directory/${DOMAIN}/${DOMAIN}.key"
if ! docker compose exec -T caddy test -f "${CERT/\/caddy\//\/data\/}"; then
  echo "❌ Caddy has no certificate for $DOMAIN yet (is https://$DOMAIN working?)"; exit 1
fi

python3 - "$DOMAIN" "$CERT" "$KEY" <<'PY'
import re, sys
domain, cert, key = sys.argv[1:4]
p = "livekit.yaml"
s = open(p).read()
block = f"""turn:
  enabled: true
  domain: {domain}
  udp_port: 3478              # TURN over UDP (most mobile data)
  tls_port: 5349              # TURN over TLS (strict Wi-Fi / firewalls)
  cert_file: {cert}
  key_file: {key}
"""
# replace the old "turn:" section (up to the next top-level key)
s, n = re.subn(r"(?m)^turn:\n(?:[ \t]+[^\n]*\n)*", block, s)
if n == 0:
    s = s.rstrip("\n") + "\n" + block
# remove the old comment that said TURN is off
s = re.sub(r"(?m)^# TURN is off:.*\n(^#.*\n)?", "", s)
open(p, "w").write(s)

p = "docker-compose.yaml"
s = open(p).read()
if "caddy_data:/caddy" not in s:
    s = s.replace("      - ./livekit.yaml:/etc/livekit.yaml",
                  "      - ./livekit.yaml:/etc/livekit.yaml\n      - caddy_data:/caddy:ro   # HTTPS certificate for TURN/TLS", 1)
open(p, "w").write(s)
print("✅ config updated")
PY

echo "▶ Firewall: open 3478/udp + 5349/tcp"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 3478/udp >/dev/null
  ufw allow 5349/tcp >/dev/null
  ufw allow 7881/tcp >/dev/null
fi

echo "▶ Restarting LiveKit…"
docker compose up -d
sleep 6
if docker compose logs --since 20s livekit 2>&1 | grep -qiE "turn|starting"; then :; fi
docker compose logs --since 20s livekit 2>&1 | grep -iE "turn|error|fatal" | tail -8 || true

# Caddy renews the certificate every ~60 days; LiveKit reads it at start.
# Restart LiveKit on the 1st of every month at 2:10 AM (no class at that time).
CRON='10 2 1 * * cd /opt/livekit && docker compose restart livekit >/dev/null 2>&1'
( crontab -l 2>/dev/null | grep -v "docker compose restart livekit" ; echo "$CRON" ) | crontab -
echo "▶ Monthly certificate refresh added (1st of each month, 2:10 AM)"

if docker compose ps livekit | grep -qiE "up|running"; then
  echo "✅ LiveKit is running with TURN (UDP 3478 + TLS 5349)."
  echo "   Undo: cp livekit.yaml.bak_$STAMP livekit.yaml && cp docker-compose.yaml.bak_$STAMP docker-compose.yaml && docker compose up -d"
else
  echo "❌ LiveKit did not start → putting the old config back"
  cp "livekit.yaml.bak_$STAMP" livekit.yaml
  cp "docker-compose.yaml.bak_$STAMP" docker-compose.yaml
  docker compose up -d
  docker compose logs --tail 30 livekit
  exit 1
fi
