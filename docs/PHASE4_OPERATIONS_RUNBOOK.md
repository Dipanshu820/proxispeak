# ProxiSpeak — Operations Runbook (Phase 4)

Operational procedures for the single-process Node backend and the static
frontend. Nothing here assumes a specific hosting provider.

---

## 1. Signals and health

| Check | Command | Healthy |
| --- | --- | --- |
| Process alive | `GET /api/health` | `200`, `{"ok":true,...}` |
| Database | same payload | `"mongodb":"connected"` (or `"disabled"` when intentionally unconfigured) |
| Startup config | process log | `ProxiSpeak server listening at http://localhost:4000` |
| Auth config | log at boot | `WARNING:` lines are tolerable in dev, never in production |
| Rooms | application UI | two browsers see each other; `● CONNECTED` |

`/api/health` returns `401` when `HEALTH_TOKEN` is set and the bearer is missing
or wrong. With a database configured but unreachable, `ok` becomes `false` and
`mongodb` becomes `error`; the office continues to work without persistence.

Development-only health fields (`port`, `memory`, `cpu`, `auth`) are not exposed
in production. Do not add tokens, TURN secrets, or connection strings to health
payloads.

### Logs

- Startup: fatal configuration errors are prefixed `FATAL:` and exit 1.
- MongoDB outages are logged at most once per 30 s and the URI is redacted.
- Uncaught exceptions print the message only (no stack) and trigger a graceful
  shutdown; the process exits 1.
- Tokens, secrets and credentials must never appear in logs. If one does, treat it
  as a security incident and rotate it.

---

## 2. Graceful restart

`SIGTERM`/`SIGINT`:

1. clears the MongoDB watchdog,
2. disconnects all sockets,
3. stops accepting HTTP connections,
4. closes the database client,
5. forces exit after 10 s if connections linger.

Rolling restart procedure:

1. Drain traffic at the proxy (stop routing to this instance).
2. Send `SIGTERM`; confirm the process exits within ~10 s.
3. Start the new process and wait for the `listening` log line.
4. Smoke test `/api/health`, then a session request, then a two-browser join.
5. Re-enable traffic.

A restart invalidates **no** tokens, but it clears the in-memory revocation list
(see the security doc). If a token was revoked before the restart, it becomes
usable again until `exp` — another reason to keep TTLs short.

---

## 3. Incident procedures

### 3.1 Authentication failures

Symptoms: users report "Disconnected", `/api/auth/session` returns `401/403/429/503`.

| Response code | Meaning | Action |
| --- | --- | --- |
| `401 INVALID_JOIN_CODE` | wrong/missing join code | check `JOIN_CODE` and the client build's `VITE_JOIN_CODE` |
| `403 ORIGIN_FORBIDDEN` | frontend origin not allowed | add the exact bare origin to `CLIENT_ORIGIN`; verify the proxy preserves `Origin` |
| `403 HTTPS_REQUIRED` | production request not seen as HTTPS | set `TRUST_PROXY` to the real hop count; ensure the proxy sends `X-Forwarded-Proto` |
| `403 ROOM_FORBIDDEN` | room not on `ALLOWED_ROOMS` or token room mismatch | issue the token for the room being joined |
| `429 RATE_LIMITED` | >240 session requests/min from one IP | confirm the proxy forwards real client IPs (`TRUST_PROXY`); block abusive sources |
| `503 AUTH_NOT_CONFIGURED` | no join code and anonymous issuance disabled | configure `JOIN_CODE` or an upstream issuer |
| `AUTH_EXPIRED` on sockets | expected at TTL; the client should refresh | investigate only if it loops |

Verify quickly:

```bash
curl -i -X POST https://host/api/auth/session \
  -H 'content-type: application/json' \
  -H 'origin: https://proxispeak.example.com' \
  -H "x-proxispeak-join-code: $JOIN_CODE" \
  -d '{"roomId":"design-team","name":"ops-probe"}'
```

Never paste a real token into a ticket or chat.

### 3.2 No audio / one-way audio

1. Confirm both clients show `AUDIO LIVE` (mic enabled) and the same room.
2. Check browser console for `WebRTC:` lines. Repeated
   `failed to create offer` / `failed to apply remote description` indicates a
   signalling problem; `Web Audio API unavailable` means the page cannot play
   remote audio at all.
3. Confirm `GET /api/ice` returns `turnEnabled: true` when peers are behind
   restrictive NATs. Without TURN, symmetric NATs will fail.
4. Ask both users to enable the mic after page load (AudioContext unlock needs a
   gesture). A reconnect deliberately keeps the unlocked context; a full reload
   requires a new click.
5. Inspect `window.__proxispeakWebrtc.getPeerDiagnostics()` in DevTools: it
   reports `connectionState`, `audioGraph`, `gain`, `transceivers` and
   `audioContextState` with no media, SDP, or credentials.

If `connectionState` is `connected` but `audioGraph` is false, the remote track
never arrived (renegotiation/signalling). If `audioGraph` is true and `gain` is 0,
the avatars are outside `EARSHOT_RADIUS_PX` (100 px) — move closer.

### 3.3 Database outage

Expected behaviour: presence, movement and audio keep working; `/api/health`
reports `mongodb: "error"`; the watchdog retries.

Actions:

1. Confirm the failure is the database, not the app (`/api/health` responds).
2. Restore MongoDB connectivity; no app restart is required — the watchdog
   reconnects and reports `connected`.
3. If errors flood the log, verify the 30 s throttle is in effect; do not raise
   the log level to hide it.

### 3.4 TURN failure

Symptoms: remote peers connect only on the same LAN; `turnEnabled: false`; ICE
`failed` after ~30 s.

1. `GET /api/ice` with a valid token: confirm `turnEnabled` and that a `turn:`/
   `turns:` entry with a username/credential is present.
2. Check that `TURN_URLS` and `TURN_SECRET` are set together and the secret is
   >= 16 chars (startup refuses otherwise).
3. Verify coturn `use-auth-secret` is enabled and the clocks agree (credentials
   embed an expiry timestamp).
4. For a relay-only verification run, set `ICE_TRANSPORT_POLICY=relay`
   (restart required) and confirm the selected candidate pair is `relay` in
   `chrome://webrtc-internals`. Reset to `all` afterwards.
5. Rotating `TURN_SECRET` requires a restart; existing sessions fetch fresh
   credentials on their next `/api/ice` call.

### 3.5 Signalling overload

Symptoms: `RATE_LIMITED` errors, rising position RTT, event-loop lag.

1. Compare against the measured baseline (see `docs/PHASE4_TEST_MATRIX.md`).
2. Per-socket limits are 20 position updates/s and 120 signalling events/10 s;
   the client throttles position to 10/s.
3. Reduce room size or shard rooms before scaling the process; the full mesh is
   O(n²) on the client regardless of server capacity.
4. Adding a second instance without a Socket.IO adapter and shared revocation
   store will break correctness, not just consistency.

---

## 4. Security operations

- Rotate `SESSION_SECRET` by restarting with a new value. All existing sessions
  become invalid (their signatures no longer verify) — this is the fastest
  global logout.
- Rotate `JOIN_CODE` by restarting and rebuilding the frontend if
  `VITE_JOIN_CODE` is used.
- Rotate TURN credentials by restarting with a new `TURN_SECRET`; ephemeral
  credentials are reissued per session.
- Revoke a single leaked token: `POST /api/auth/revoke` with that token as the
  bearer. Confirm the response reports `disconnected`, then confirm the token is
  refused at `/api/ice`.
- Never enable `PROXISPEAK_ALLOW_HTTP_ORIGIN` or `AUTH_ALLOW_ANONYMOUS` on an
  internet-facing deployment.

---

## 5. Backup and data

MongoDB stores optional profiles/offices/session history, not audio. Back it up
with your normal MongoDB tooling. The application can run without it; do not
block an incident response on restoring it unless persistence is required.
