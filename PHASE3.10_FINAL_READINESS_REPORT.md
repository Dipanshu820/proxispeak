# ProxiSpeak Phase 3.10 — Production Readiness Closure

**Date:** October 18, 2026
**Final status:** `PARTIALLY VERIFIED`

Why not `VERIFIED`: every automated requirement that this environment can execute is
implemented and measured (authentication, room authorization, TURN configuration,
MongoDB outage/recovery, signaling load, two- and three-browser WebRTC reliability).
Three acceptance criteria still require resources that are not present here:
**human-audible microphone audio** (no physical microphone; Chromium's fake device is
silent), **real TURN connectivity** (no TURN server), and **browser media at scale**
(the load test measures server signaling only; the mesh is O(n²)). In addition, the
new authentication proves an **application session**, not a human identity — there is
no account system or identity provider. Nothing here claims production readiness for
open deployment or 50 concurrent *media* users.

---

## 1. Files changed and why

### Server

| File | Change | Why |
|---|---|---|
| `server/auth.js` | **New.** HMAC-SHA256 signed, expiring session tokens (`v1.<claims>.<sig>`), strict base64url, timing-safe comparison, join-code verification, environment-driven configuration with a production fail-closed guard. | There was no authentication at all. Tokens are issued by the server, bind a server-generated subject to one room, and are verified before any socket handler runs. |
| `server/ice.js` | **New.** STUN/TURN parsing and ICE list construction, including coturn `use-auth-secret` ephemeral credentials (HMAC-SHA1, expiring). | TURN support with no hardcoded credentials. Credentials are served per session, never compiled into the bundle. |
| `server/server.js` | Auth HTTP endpoints (`POST /api/auth/session`, `GET /api/ice`), console-safe health, Socket.io handshake middleware, token-bound `office:join`, single-live-socket-per-subject eviction, `webrtc`-independent session cleanup, position acknowledgement, comma-separated CORS origins, MongoDB watchdog, redacted error logging. | Wire the new security model into the real entrypoint and make failures visible without leaking secrets. |
| `server/webrtc.js` | Requires an authenticated socket on every signaling handler; replaced the single mutable per-pair signaling state with a **set of directed pending offers**. | Authorization, plus a real glare/reconnect bug: a crossing offer overwrote the recorded offer, so the legitimate answer was rejected with `NO_SIGNALING_STATE`. |
| `server/config.js` | `sanitizeRoomId`, `parseClientOrigins`, `validateClientOrigins`. | Room ids are signed claims and log-safe; deployments can list more than one frontend origin. |
| `server/db.js` | `ping()` liveness probe, `redactMongoUri()`, bounded server-selection timeout, credential-free connection log. | Health must not report a stale "connected"; connection strings embed credentials and must never be logged. |
| `server/load-test.js` | **New** bounded Socket.io load test (auth, join, position RTT/throughput, ICE relay, errors, RSS/CPU). | Measure instead of claiming scalability. |
| `server/auth.test.js` | **New.** 38 tests: signer/verifier, expiry, tampering, wrong secret, malformed input, replay/eviction, spoofed display name, cross-room join and signaling, reconnect cleanup, log/secret leakage, real production processes. | Required security evidence. |
| `server/ice.test.js` | **New.** 12 tests: parsing, ephemeral credential formula, static fallback warning, misconfiguration, real `/api/ice` endpoint. | TURN configuration evidence. |
| `server/mongo-recovery.test.js` | **New, gated** (`PROXISPEAK_MONGO_RECOVERY=1`). Real server + real `mongo:7` container: outage, health reporting, automatic reconnection. | Prove failure/recovery behavior. |
| `server/startup.test.js` | +9 tests (origin lists, room ids, auth-required issuance/join), production starts now require `SESSION_SECRET`, `cleanEnv` clears auth/TURN vars. | Match the new fail-closed contract without weakening origin guards. |
| `server/webrtc.test.js` | Harness marks sockets authenticated (the handshake itself is tested against the real server). | Signaling tests now exercise an authenticated post-handshake socket. |
| `server/db.test.js` | +3 URI-redaction tests. | Prove secrets cannot reach logs. |
| `server/.env.example`, `server/package.json` | Documented `SESSION_SECRET`, `JOIN_CODE`, `AUTH_ALLOW_ANONYMOUS`, `SESSION_TTL_SECONDS`, `ALLOWED_ROOMS`, `HEALTH_TOKEN`, `TURN_*`, `MONGODB_WATCHDOG_MS`; added `npm run load-test`. | Deployability. |

### Client

| File | Change | Why |
|---|---|---|
| `src/utils/auth.js` | **New.** Same-origin session and ICE requests; token kept in memory only; typed `AuthError` codes; no logging of tokens. | The browser must not invent identity, and must not persist the session where XSS can lift it. |
| `src/utils/socket.js` | Sends the token in the Socket.io handshake; no longer sends a client-supplied name; refreshes an expired session and reconnects; tracks the last room for refresh. | Server-verified identity on the wire, recoverable expiry. |
| `src/utils/webrtc.js` | Attaches the microphone to the transceiver created by a remote offer before answering (fixes one-way audio after glare rollback); diagnostics now expose media-line directions and RTP counters (`getPeerStats`). | Root-caused defect: the polite peer answered `recvonly`, so the other side received a permanently muted track. |
| `src/pages/VirtualOffice.jsx` | Session bootstrap before connecting, auth error surface (no token), reconnect-safe peer initiation driven by the roster, credential-free test hook. | Wire auth in without breaking the office; peers must be re-created after a reconnect. |
| `vite.config.js` | `/api` proxy for both dev and `preview`; configurable socket URL. | Session/ICE calls are same-origin, so authentication never depends on CORS. |
| `src/__tests__/auth.test.js` | **New.** 11 tests. | Client session/ICE behavior. |
| `src/__tests__/setup.js` | Disables inherited global `fetch` in unit tests. | Unit tests were silently reaching a developer's live backend once the component bootstrapped a session. |
| `tests/browser/webrtc-reliability.spec.js` | **New.** Mic cycles, transport interruption/reconnect, three-peer independent gain. | Reliability requirements that have runtime evidence. |
| `README.md` | Auth/configuration section, updated limitations. | The old README still claimed there was no WebRTC or server integration. |

---

## 2. Authentication and authorization design

**Token.** `POST /api/auth/session` returns a token signed with `SESSION_SECRET`
(HMAC-SHA256) containing `{ v, sub, name, room, jti, iat, exp }`. `sub` is a
server-generated UUID; the display name is normalized server-side and signed in.
Default lifetime is 3600 s (`SESSION_TTL_SECONDS`, 60–86400). Every socket must
present it in `handshake.auth.token`; `io.use()` verifies structure, signature,
expiry, issued-at skew, and bounds before any handler is registered.

**Room authorization.** The token is bound to exactly one room. `office:join`
rejects any other room (`ROOM_FORBIDDEN`) even when that room exists and is on
`ALLOWED_ROOMS`. Position/speaking broadcasts and all four signaling events
(`initiate`, `offer`, `accept`, `ice-candidate`) require a joined room, and target
sockets must share that room. An answer must correspond to a recorded directed
offer; self-answers and third-party answers are rejected.

**Identity.** `socket.data.user = { id: socket.id, name: <signed name> }`. A client
cannot rename itself in `office:join`, cannot publish as another socket, and cannot
read another room. Replaying a live token opens a new socket with the same subject;
the older socket is disconnected, so two connections cannot act as one participant.

**What this protects:** the office boundary, the identity used on the wire,
movement/signaling authorization, and cross-room isolation. **What it does not
protect:** it does not prove who a human is. Without an upstream identity provider,
anyone with the join code (or, in development, anyone) can obtain a session and use
the display name they type. There are no accounts, passwords, revocation lists,
per-user ACLs, or audit trail. A stolen live token works until it expires; short TTLs
and HTTPS are the mitigation. TURN credentials and session tokens are never logged
(asserted by test).

**Production fail-closed behavior (measured):**

| Configuration | Result |
|---|---|
| No `CLIENT_ORIGIN` | exit 1 — `FATAL: CLIENT_ORIGIN is not configured for production` |
| Wildcard `CLIENT_ORIGIN` | exit 1 — `must not contain a wildcard` |
| Malformed origin | exit 1 — `not a valid absolute URL` |
| No `SESSION_SECRET` | exit 1 — `SESSION_SECRET is required in production` |
| Short `SESSION_SECRET` | exit 1 — `must be at least 32 characters` |
| `TURN_URLS` without credentials | exit 1 — `neither TURN_SECRET nor TURN_USERNAME/TURN_CREDENTIAL` |
| Weak `JOIN_CODE` | exit 1 — `must be at least 12 characters` |
| Valid origin + secret, no join code | starts; `POST /api/auth/session` → **503**; `/api/ice` anonymous → **401** |
| Valid origin + secret + join code + TURN | starts; wrong/absent code → **401**, correct code → **200**; `/api/ice` with token → **200** with ephemeral TURN credentials; health returns only `{ok, service, mongodb}` |
| Development default | starts with a labelled, insecure fallback secret and anonymous issuance |

CSRF is not applicable to the token endpoints (no cookies; `credentials: 'omit'`),
but CORS still restricts which browser origins may call them.

---

## 3. Exact commands and measured results

All commands run from the repository on Windows (Git Bash). Node v24.18.0.

| # | Command | Result |
|---|---|---|
| 1 | `cd proxispeak/server && npx vitest run` | **130 passed, 9 skipped (139)**, exit 0, 9.7 s — `auth.test.js` 38, `startup.test.js` 28, `webrtc.test.js` 26, `server.test.js` 14, `db.test.js` 12, `ice.test.js` 12; skipped: `db.live.test.js` 6 + `mongo-recovery.test.js` 2 (both gated) + 1 pre-existing skip |
| 2 | `cd proxispeak && npx vitest run --pool=forks` (×3 consecutive runs) | **153 passed (11 files)**, exit 0, 6.3 / 6.5 / 7.0 s |
| 3 | `cd proxispeak && npm run build` | success — `dist/assets/index-BmWbNTDa.js` 325.42 kB (100.40 kB gzip), CSS 27.71 kB (6.91 kB gzip) |
| 4 | `cd proxispeak && npx playwright test --project=chromium-desktop` | **37 passed, 7 skipped**, exit 0, 1.2 m |
| 5 | `cd proxispeak && npx playwright test --project=chromium-mobile` | **38 passed, 6 skipped**, exit 0, 1.3 m |
| 6 | `cd proxispeak && npx playwright test tests/browser/webrtc-peer.spec.js tests/browser/webrtc-reliability.spec.js --project=chromium-desktop-fake-media` | **5 passed**, exit 0, 1.4 m — lifecycle 58.9 s, mic cycles 7.9 s, reconnect 6.0 s, three peers 9.0 s, mic-denied 2.0 s |
| 7 | `docker run -d --name proxispeak-mongo-test -p 27018:27017 mongo:7` then `cd server && MONGODB_TEST_URI=mongodb://127.0.0.1:27018 npx vitest run db.live.test.js` | **6 passed**, exit 0 |
| 8 | `cd server && PROXISPEAK_MONGO_RECOVERY=1 npx vitest run mongo-recovery.test.js` | **2 passed**, exit 0, 8.1 s (real `mongo:7` container started/stopped/restarted) |
| 9 | `cd server && node load-test.js --clients 20 --duration 10 --hz 5 --rooms 1 --signaling-pairs 4` | exit 0 (see §9) |
| 10 | `cd server && node load-test.js --clients 20 --duration 10 --hz 5 --rooms 20 --signaling-pairs 0` (control) | exit 0 (see §9) |
| 11 | `cd server && node load-test.js --clients 50 --duration 15 --hz 2 --rooms 1 --signaling-pairs 6` | exit 0 (see §9) |

No passing test was deleted, skipped, or weakened. The only fixture changes are the
authenticated socket in `webrtc.test.js` (signaling tests now model a valid
post-handshake socket; the handshake itself is covered in `auth.test.js`) and
production startup tests now supplying `SESSION_SECRET`, which is newly required by
design.

---

## 4. Backend / frontend / build / browser results

- **Backend:** 130 passing tests, all green across auth, ICE, startup guards, signaling
  state machine, HTTP health, and coordinate mapping. Live and recovery suites are
  gated and were run separately (both green).
- **Frontend:** 153 tests, stable across three consecutive runs. Covers the new
  session client (11 tests), negotiation lifecycle, proximity gain, collision,
  persistence, microphone failure, and rendering.
- **Build:** succeeds; output hash recorded above. Browser tests served that exact
  `dist` through `vite preview` with the `/api` proxy.
- **Desktop:** 37 passed. **Mobile:** 38 passed (the Phase 3.9 timeout did not recur).
  The skips are the five fake-media tests (they require the fake-media project) plus
  the pre-existing microphone-meter skip, and — on desktop only — the pre-existing
  desktop pointer-drag skip: 5 + 2 = 7 on desktop, 5 + 1 = 6 on mobile.
- **No uncaught page errors** were observed in the WebRTC lifecycle or reliability
  specs; the reconnect/mic-cycle specs assert this explicitly.

---

## 5. WebRTC evidence (fake media)

**Two-browser lifecycle** (`webrtc-peer.spec.js`, 58.9 s): both contexts join, enable
the microphone, complete a real offer/answer/ICE exchange, reach
`connectionState: "connected"`, hold **exactly one** peer connection each, receive a
remote audio track with a live source→gain→destination graph, and track proximity:
walking outside 100 px drives the receiving gain to 0, walking back raises it to the
value predicted by `0.1 + 0.9·(1 − d/100)` (tolerance 0.1). Mute is local; disconnect
removes peer and audio graph; a new session and a remount renegotiate with exactly one
peer.

**Repeated mic cycles** (`webrtc-reliability.spec.js`): disable/enable twice. The peer
id is unchanged, `localAudioSenders === 1` (the stopped sender is reused via
`replaceTrack`), the connection stays `connected`, and **bidirectional RTP packet
counters keep increasing** after the cycles.

**Transport interruption and reconnection:** severing the socket transport gives a new
socket id, the client re-presents the same signed session, re-joins, and both sides end
with **exactly one** peer pointing at the new id, connected, with inbound/outbound RTP
counters rising on both sides. This is a deliberate transport close, not a real network
partition; see limitations.

**Three peers, independent gain:** each side holds two peers. Walking A out of earshot
makes B's gain to A **0** while B's gain to C stays **> 0.5** at the same moment; A
likewise reports B silent; C still holds two peers.

**Defects found and fixed in this phase**

1. **Crossing offers corrupted server state (one-way/stuck negotiation).** The server
   stored one mutable value per socket pair. When both peers offered (glare, reliably
   reproduced by reconnect), recording offer A→B overwrote offer B→A with `'answer'`,
   so A's legitimate answer was rejected with `NO_SIGNALING_STATE` and B stayed in
   `have-local-offer` indefinitely. Replaced with a set of directed pending offers;
   answered exchanges consume only their own direction. Browser evidence: reconnect
   went from “stuck connecting for 30 s” to “connected in ~5 s”.
2. **One-way audio after a glare rollback.** After rollback, the polite peer answered
   the remote offer on a transceiver created by the remote m-line, leaving its
   pre-existing sender unassociated: the answer was `recvonly`, so the other side got a
   track that stayed muted. `attachLocalAudioToTransceivers()` now binds the live mic
   track before `createAnswer`. Evidence: `transceivers[0] = sendrecv/sendrecv` on both
   sides and inbound+outbound RTP packets increasing in both directions.
3. **Peers were never re-created after a reconnect.** The peer-initiation effect only
   depended on the first join. It now follows the roster and only creates connections
   that do not already exist (so 10 position updates/s do not cause a renegotiation
   storm).
4. **Unit tests reached a live backend.** jsdom inherits Node's `fetch`; the new
   session bootstrap would call a developer's running server and open real sockets.
   `src/__tests__/setup.js` now disables network fetch in unit tests (auth tests inject
   their own).
5. **MongoDB URI could reach logs with credentials.** Added redaction and a test;
   connection/error logs now use it.
6. **`/api/health` reported a stale `connected`.** It now pings the database, and a
   watchdog reconnects after outages.

**Media vs. track state.** With Chromium's fake device the receiver's
`track.muted` is unreliable: packets flow (counters prove it) while the flag can
remain `true` because the synthetic stream is digital silence. Reliability assertions
therefore use RTP counters and negotiated directions; `track.muted` is not treated as
proof of audibility or of failure.

---

## 6. Fake media vs. actual audible audio

| Level | Status |
|---|---|
| Signaling decisions, glare, ICE buffering, authorization | VERIFIED — unit + real server + browser |
| Real `RTCPeerConnection` reaches `connected` in two/three browsers | VERIFIED |
| Audio transceiver is `sendrecv` in both directions | VERIFIED |
| Remote track + audio graph exist; RTP packets flow both ways | VERIFIED |
| Proximity gain matches measured pixel distance; independent per peer | VERIFIED |
| Mic cycles reuse one sender; mute/unmute; cleanup; remount | VERIFIED |
| **Human-audible microphone → speaker audio** | **NOT TESTED** — no physical microphone; fake device is silent |

---

## 7. MongoDB

- **Persistence/live:** 6/6 against a real `mongo:7` container — indexes (unique email,
  2dsphere, office slug, session indexes), persistence across a client reconnect,
  unique-email enforcement, virtual coordinate mapping, real `$geoWithin` query scoped
  to one office.
- **Outage:** with `MONGODB_URI` pointing at a closed port the server starts and serves
  sessions, joins, and movement; `/api/health` returns `ok:false, mongodb:"error"`.
- **Recovery:** starting the container moves health to `connected`; stopping it is
  detected by ping (`ok:false`); restarting it reconnects automatically without a
  server restart; the office still authenticates and joins afterwards.
- Connection strings are redacted in every log line; `connect()` uses a bounded
  server-selection timeout so startup cannot hang on an unreachable host.

---

## 8. TURN

Configured entirely by environment: `TURN_URLS`, `TURN_SECRET` (ephemeral, coturn
`use-auth-secret`), or `TURN_USERNAME`/`TURN_CREDENTIAL` (static, warned), plus
`TURN_TTL_SECONDS`; optional `STUN_URLS`. The list is returned by `GET /api/ice` only
to a request carrying a valid session token, so credentials are never bundled into the
frontend. A production server with `TURN_URLS` but no credentials refuses to start;
development warns and serves STUN only. Measured: ephemeral credential generated for
`turns:turn.example.com:5349`, username `"<expiry>:<subject>"`, HMAC-SHA1 credential,
shared secret absent from the response, `Cache-Control: no-store`; anonymous request
401.

**Real TURN connectivity was NOT tested** — no TURN/STUN server was reachable from this
environment. NAT traversal across restrictive firewalls therefore remains unverified.

---

## 9. Load test — methodology and measurements

`server/load-test.js` drives real Socket.io clients against a running server. Each
client obtains a real session token from `/api/auth/session`, connects with it, joins a
room, then emits `position:update` at the configured rate with an acknowledgement. The
ack measures client→server→ack latency. Room broadcasts are counted on every receiver.
The signaling phase sends tagged ICE candidate strings between pairs and measures relay
delivery plus end-to-end latency. The server's RSS and cumulative CPU are read from
`/api/health` before and after; the load generator's own CPU is measured with
`process.cpuUsage()`.

**This is server signaling load only.** No RTCPeerConnections are created, no media is
encoded, and no browser is involved. It says nothing about browser media capacity.

### A. 20 clients, 1 room, 5 Hz, 10 s, 4 signaling pairs — exit 0

| Metric | Measurement |
|---|---|
| Connected | 20/20 |
| Session latency | p50 8.91 ms / p95 15.81 ms / p99 18.24 ms |
| Connect latency | p50 4.48 ms / p95 8.36 ms / p99 27.29 ms |
| Join latency | p50 1.60 ms / p95 2.53 ms / p99 3.31 ms |
| Position emits / acks | 980 / 980 (**100 %**) |
| Broadcast deliveries | 18,620 (≈ **1,862 / s**) |
| Position ack RTT | p50 **19.13 ms** / p95 **141.29 ms** / p99 **336.19 ms** |
| ICE relay | 80/80 delivered; p50 1 ms / p95 2 ms / p99 5 ms |
| Errors | 0 |
| Server CPU | **13.7 % of one core** |
| Server RSS delta | +462,848 bytes |
| Generator CPU | 14.2 % of one core |

### B. Control: 20 clients, 20 rooms (no fan-out), 5 Hz, 10 s — exit 0

940 emits, 100 % acked, 0 broadcast deliveries, RTT p50 **7.14 ms** / p95 **68.19 ms** /
p99 101.9 ms, server CPU **3.2 %**. The difference from A isolates room fan-out as the
source of the latency tail; both runs share one single-threaded generator process, so
the generator is part of the tail.

### C. 50 clients, 1 room, 2 Hz, 15 s, 6 signaling pairs — exit 0

| Metric | Measurement |
|---|---|
| Connected | 50/50 |
| Position emits / acks | 1,450 / 1,441 (**99.4 %**) |
| Broadcast deliveries | 70,636 (≈ **4,709 / s**) |
| Position ack RTT | p50 **73.5 ms** / p95 **574.59 ms** / p99 **1,989.67 ms** |
| ICE relay | 120/120 delivered; p50 27 ms / p95 223 ms / p99 225 ms |
| Errors | 0 server errors; 9 position acks missing |
| Server CPU | **23.9 % of one core** |
| Server RSS delta | +5,275,648 bytes |
| Generator CPU | 23.9 % of one core |

Interpretation: **server signaling** handled 50 clients and ~4.7 k fan-out
messages/second on one Node process at ~24 % CPU, with zero protocol errors. The
99.4 % ack rate and the p95/p99 tail are reported as measured, not smoothed: the
generator and server share one machine and the generator is single-threaded. **This is
not evidence for 50 concurrent media users.** A full mesh at 50 participants means 49
RTCPeerConnections per browser (2,450 total) and ~2,500 encoded streams; that requires
an SFU (LiveKit or mediasoup). No migration was attempted: it would be a large
architectural change without browser-media evidence, and the current architecture
keeps working.

Reproduce with:
```bash
cd proxispeak/server
node server.js                      # dev, SESSION_SECRET optional
node load-test.js --clients 50 --duration 15 --hz 2 --rooms 1 --signaling-pairs 6
```
For a larger test, run the generator on separate hardware and the server on its own
host, and add `MONGODB_URI` if you want persistence included.

---

## 10. Remaining blockers and manual verification

**Blockers / unverified requirements**

1. **Identity is an application session, not a person.** No accounts, IdP, revocation,
   or per-user ACL. Production issuance is disabled unless `JOIN_CODE` is set or an
   upstream mints tokens. Do not expose this build publicly without that decision.
2. **Audible audio is unverified.** Requires two real microphones (below).
3. **Real TURN connectivity is unverified.** Needs a deployed TURN server and a
   restrictive network.
4. **Browser media at scale is unverified.** Server signaling was measured; the mesh is
   O(n²) and needs an SFU for larger rooms.
5. **Replay window.** A stolen live token works until expiry (default 1 h). A second
   socket using the same token evicts the first (tested), but there is no revocation
   list. Use short TTLs and HTTPS.
6. **Client token-refresh path** (expired session → re-issue → reconnect) is implemented
   but not exercised end-to-end; server-side expiry rejection is tested.
7. **Abrupt network partition** (rather than a transport close) relies on Socket.io
   heartbeat detection and was not exercised; the deterministic reconnect path was.
8. **Mute is client-enforced**; a modified client can transmit while reporting silent.
9. **Position acks under heavy fan-out**: 9/1,450 missing at 50 clients with no server
   error event. The single-process generator is the likely contributor; not root-caused.
10. Fake-media `track.muted` is not a usable audibility signal (silence); documented so
    future tests do not assert on it.

### Manual Windows / Chrome procedure — audible audio (must not be marked passed until run)

Prerequisites: Node LTS, this repository, headphones (prevents feedback), two Chrome
profiles.

1. Start the backend with a real secret and a room allowlist:
   ```bash
   cd proxispeak/server
   SESSION_SECRET=<32+ random chars> ALLOWED_ROOMS=design-team PORT=4000 node server.js
   ```
2. Build and serve the frontend:
   ```bash
   cd proxispeak
   npm run build
   npx vite preview --port 4173 --host 127.0.0.1
   ```
3. Open two independent Chrome windows (separate profiles so microphone permissions are
   independent):
   ```bat
   chrome.exe --user-data-dir=%TEMP%\ps-a http://localhost:4173
   chrome.exe --user-data-dir=%TEMP%\ps-b http://localhost:4173
   ```
4. In both: **Enter Office**, confirm `Real-time with 1 remote` (each side sees the
   other) and that the browser console shows no authentication or signaling errors.
5. In both: **Enable microphone** → **Allow** the Chrome prompt. If nothing appears,
   open `chrome://settings/content/microphone` for that profile and remove
   `http://localhost:4173` from "Not allowed", then reload.
6. Speak into A: confirm you hear it in B, and speak into B to confirm the reverse.
   **Both directions** are required; one-way audio is a failure.
7. Walk the avatars apart and together with WASD/arrows: voice must fade out at the
   earshot ring and return on approach, on both sides, with no clicks or stuck gain.
8. Mute/unmute A: B must stop and resume hearing A while A continues to hear B.
9. Close B: A must see the avatar leave and hear nothing stale. Reopen B, re-enter,
   enable the mic: audio must work again with exactly one B visible.
10. Block the microphone for the origin and click **Enable microphone**: expect the
    permission toast, no peer, and movement still working.
11. Stop the backend and reload: the office must show “Secure session unavailable” and
    must **not** connect, rather than silently falling back to an unauthenticated mode.
12. On a network that is not localhost (different subnets/NAT), repeat steps 4–7. Without
    a TURN server, a failure here is expected on symmetric NAT; configure `TURN_URLS` +
    `TURN_SECRET` and repeat. Real TURN success must be recorded separately.

### Manual TURN check (when a TURN server exists)

```bash
cd proxispeak/server
TURN_URLS=turn:YOUR_TURN_HOST:3478 TURN_SECRET=YOUR_SHARED_SECRET \
SESSION_SECRET=<32+ chars> CLIENT_ORIGIN=https://your.frontend node server.js
curl -s http://localhost:4000/api/ice -H "Authorization: Bearer <session token>"
```
Then run the two-browser procedure from two different networks. Confirm the ICE
candidate pair is `relay` (Chrome `chrome://webrtc-internals`) and that audio still
flows. Until that is done, TURN connectivity remains **unverified**.
