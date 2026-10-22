# 🧪 Load test (before the real 2,000 students)

Run from your laptop (Mac), NOT from the audio server.

```bash
brew install livekit-cli
# 1 room, 1 trainer talking, 300 listening students
lk load-test --url wss://audio.yourdomain.com --api-key KEY --api-secret SECRET \
  --room loadtest --audio-publishers 1 --subscribers 300 --duration 3m
```

On the audio server, watch CPU while it runs:
```bash
htop
```
- CPU under 60% at 300 → try `--subscribers 1000`, then 2000 (use 2–3 laptops if one laptop is too slow).
- If the test says the room does not exist: on the server set `auto_create: true` in `/opt/livekit/livekit.yaml`, run `cd /opt/livekit && docker compose restart livekit`, test, then set it back to `false` and restart again.
