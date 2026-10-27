# ProxiSpeak — Final Completion Report

Repository: `proxispeak/` (React + Vite + Tailwind frontend, Node + Socket.IO
backend, optional MongoDB).
Environment: Windows, Git Bash, Node 24. `master` branch has **no commits** —
the whole tree is untracked, so there is no committed baseline to diff against and
nothing was committed or reset.
Report date: 2026-10-19.

Status labels: **VERIFIED** · **IMPLEMENTED, NOT END-TO-END VERIFIED** ·
**NOT RUN** · **BLOCKED** · **NOT IMPLEMENTED** · **NOT AVAILABLE**.

> This file replaces an earlier revision whose deliverables did not exist on disk
> (`docs/PHASE4_*.md`, `.env.example`) and which cited a backend result with no
> command behind it. Every number below was produced by a command run in this
> environment; the raw sequence is in `PHASE4_EXECUTION_LOG.md`, and the
> per-check commands are in `docs/PHASE4_TEST_MATRIX.md`.

---

## 1. Executive summary

ProxiSpeak is a working proximity-audio virtual office: a React/Vite/Tailwind
office floor with keyboard- and drag-based movement, server-authorised rooms over
Socket.IO, signed expiring session tokens, and a real WebRTC audio mesh whose
per-peer gain follows avatar distance.

This execution finished the remaining feasible work: it fixed five WebRTC audio
lifecycle defects, one silent client auth failure, and a set of server security
gaps (session expiry was enforced only at the handshake, there was no revocation,
no Origin validation, no HTTPS enforcement, no validated proxy trust, and the
`office:leave` event had no server handler at all). It stabilised the frontend
suite (16 React `act()` warnings → 0), added 33 tests across three new/extended
suites, added the identity-provider integration boundary as a real,
tested surface (`server/mint-session.js`), added a local MongoDB compose file so
the gated database suites are runnable, and produced the full deployment,
security, operations, rollback, test-matrix and handoff documentation.

Verified end state: frontend 162 tests passing 5 consecutive runs with zero
warnings; backend 165 passing with 9 gated/pre-existing skips; production build
clean; desktop/mobile/fake-media browser suites green (37 / 38 / 5); 20- and
50-client signaling load tests at 100 % acknowledgements and zero server errors;
no server secret value in the built bundle.

Not verified, for external reasons only: audible two-device audio (no second
device), real TURN relay connectivity (no TURN server), live MongoDB and
outage/recovery here (no `mongod`; Docker daemon not running), and browser-media
scalability at real concurrency.

**Verdict: COMPLETE FOR LOCAL DEVELOPMENT** — see §16.

---

## 2. What is actually implemented

**Frontend** (`src/`)
- Landing page + virtual office floor; rooms and furniture rendered from one
  shared layout module (`src/utils/collision.js`) so drawn geometry equals
  collision geometry.
- Keyboard movement (WASD + arrows, physical px/s speed, frame-rate independent),
  pointer/touch dragging, furniture collision with sliding, floor-boundary
  clamping, saved/restored layouts in `localStorage`.
- Earshot ring, nearby-colleague counts, pixel-distance display, proximity
  strength bars, aria-labelled input level meter, mute/unmute, and explicit
  status for connection / mic / room / peer state.
- Session bootstrap (`src/utils/auth.js`) → socket handshake → room join →
  WebRTC (`src/utils/webrtc.js`) with perfect negotiation, glare handling,
  ICE candidate buffering, a shared gesture-unlocked `AudioContext`, one gain node
  per peer, and full cleanup.

**Backend** (`server/`)
- Express + Socket.IO: `/api/health`, `/api/auth/session`, `/api/auth/revoke`,
  `/api/ice`, 404 JSON fallback.
- HMAC-SHA256 signed, expiring session tokens bound to one room; server-generated
  subject; sanitised display name; join-code verification (timing-safe).
- Handshake authentication for every socket, per-event room/authorization checks,
  payload caps, per-socket and per-IP rate limits, one-live-socket-per-subject
  eviction, live expiry enforcement, and node-local revocation.
- WebRTC signaling relay with same-room enforcement and directional offer
  tracking (no third-party answer injection).
- Optional MongoDB: connection + indexes (including `2dsphere` on
  `location.geometry`), health watchdog with reconnect, credential redaction.
- Graceful shutdown on `SIGTERM`/`SIGINT`, uncaught-exception handling.
- `server/load-test.js` (bounded signaling load test) and
  `server/mint-session.js` (trusted-issuer session minting).

**Not implemented:** any real identity provider, per-user room ACLs, an SFU,
media recording, or cross-instance shared session/room state.

---

## 3. What was changed in this execution

### Fixed defects (each with a regression test)

| # | Defect | Where |
| --- | --- | --- |
| 1 | Replacing a closed peer connection overwrote the map entry, leaving the dead peer's source/gain connected (dead audio kept playing) | `src/utils/webrtc.js` |
| 2 | A remote track that `ended` (device removal) pinned its gain node forever | `src/utils/webrtc.js` |
| 3 | `cleanupAllPeers()` closed the shared `AudioContext` on a *transient* disconnect, so audio could not resume after reconnect without another user gesture | `src/utils/webrtc.js` |
| 4 | Dangling `track._gainNode` references pointed at disconnected nodes | `src/utils/webrtc.js` |
| 5 | Ghost remote participants (old socket ids) survived a disconnect and were re-negotiated against | `src/pages/VirtualOffice.jsx` |
| 6 | Rejected socket handshakes were never surfaced to the UI (`connect_error` consulted a listener `connect()` never registers) | `src/utils/socket.js` |
| 7 | Session expiry was enforced only at the handshake — a connected socket stayed authenticated indefinitely | `server/server.js` |
| 8 | No way to invalidate a live token before `exp` | `server/auth.js`, `server/server.js` |
| 9 | No Origin validation on state-changing requests (CORS alone is not authorization) | `server/server.js`, `server/config.js` |
| 10 | Token endpoints were reachable over plaintext in production | `server/server.js` |
| 11 | `X-Forwarded-*` had no declared trust boundary | `server/config.js`, `server/server.js` |
| 12 | `office:leave` had **no server handler** — the client believed it left, the server kept it in the room | `server/server.js` |
| 13 | 16 React `act()` warnings from async session bootstrap landing outside `act()` | `src/__tests__/officeHarness.js` + 3 test files |

### Added

- `server/mint-session.js` + `server/mint-session.test.js` — the documented
  identity-provider integration boundary, as a tested function **and** an operator
  CLI (`npm run mint-session`), so a pilot can hand-provision a session without
  writing code and an IdP has one obvious call to make.
- `server/session-security.test.js` (23 tests) — revoke, live expiry, Origin
  enforcement, HTTPS enforcement, forged `X-Forwarded-Proto` rejection, loopback
  rejection in production, `office:leave`, leave/rejoin isolation, `TRUST_PROXY`
  startup guard.
- `src/__tests__/socket-session.test.js` (5 tests) — client session refresh,
  single-flight refresh, non-retry of non-recoverable auth errors.
- `ICE_TRANSPORT_POLICY` (`all` | `relay`) end-to-end: validated in
  `server/ice.js`, exported by `/api/ice`, applied by the client to
  `RTCPeerConnection`; `relay` without TURN is a configuration error.
- `docker-compose.yml` — local `mongo:7` on **27018** (deliberately not 27017) so
  the gated live/recovery suites are runnable; optional `mongo-express` under a
  `tools` profile.
- `docs/PHASE4_DEPLOYMENT.md`, `docs/PHASE4_SECURITY.md`,
  `docs/PHASE4_OPERATIONS_RUNBOOK.md`, `docs/PHASE4_TEST_MATRIX.md`,
  `docs/PHASE4_ROLLBACK.md`, `.github/workflows/ci.yml`, `.env.example`,
  `FINAL_HANDOFF.md` (repository root).
- `server/.env.example` rewritten: `TRUST_PROXY`, `REQUIRE_HTTPS`,
  `ICE_TRANSPORT_POLICY` added, and three variables that **no code reads**
  (`WEBSOCKET_TRANSPORTS`, `PROXISPEAK_EARSHOT_PX`, `PROXISPEAK_MIN_VOLUME`)
  removed rather than documented as working features.

### Deliberately not changed

No working frontend feature was rewritten and no test was weakened, skipped, or
given a longer timeout. Two production tests in `server/auth.test.js` were
**updated** (not relaxed) because the new HTTPS guard now answers before the
join-code/503 logic over plaintext: they assert `403 HTTPS_REQUIRED` over
plaintext *and* the original 401/503 behaviour over a trusted
`X-Forwarded-Proto: https` path.

---

## 4. Architecture and major data flows

```
Browser ──POST /api/auth/session──► Express ──issueSession()──► signed token (room-bound)
   │                                                                  │
   └──Socket.IO handshake (auth.token) ◄──────────────────────────────┘
           │
           ├─ io.use(): verify signature + expiry + revocation ──► reject (never reaches a handler)
           └─ connection: per-socket expiry timer
                   │
   office:join ──► token.room == requested room && ALLOWED_ROOMS ──► room + presence broadcast
   position:update ──► rate limit → validate → clamp 0-100 → broadcast (ack)
   speaking:update ──► boolean check → broadcast
   webrtc:initiate/offer/accept/ice-candidate ──► same-room checks, offer tracking, payload caps
                   │
        Peer A ◄──── SDP/ICE relay (server never sees media) ────► Peer B
                   │
        RTCPeerConnection ── ontrack ──► MediaStreamAudioSource ──► GainNode ──► destination
                                                                    ▲
                       proximity: distancePx(avatars) ──► proximityGain() ──► setTargetAtTime (0.03 s ramp)
```

Key flows:

1. **Session issuance** — server generates the subject; the display name is
   sanitised and signed; the room is bound into the token; the browser keeps the
   token in memory only.
2. **Authorization** — every sensitive event re-checks server state
   (`socket.data.roomId`, target socket's room, `socket.data.session`). The
   frontend never authorises anything; it only reflects server state.
3. **Audio gain** — `pctToPixels()` converts avatar percentages to real pixels
   against the measured floor, so the earshot radius (100 px) and the gain curve
   share one unit system: 1.0 at 0 px, linearly to `minVolume` (0.1) at the
   earshot edge, **0 at or beyond 100 px** (silent).
4. **Recovery** — server emits `session:expired` then disconnects; the client
   mints a fresh session for the same room (single-flight) and reconnects;
   transient disconnects drop dead peers but keep the unlocked `AudioContext`.
5. **Optional persistence** — MongoDB never participates in the realtime path; a
   watchdog reports and recovers independently.

---

## 5. File-by-file change summary

### Frontend source
| File | Change |
| --- | --- |
| `src/utils/webrtc.js` | Stale-graph teardown on connection replacement; `remoteTracks` map + `_gainNode` cleanup; `ended`-track detach; opt-in AudioContext close (`cleanupAllPeers({ closeAudioContext })`, `destroy()` closes); `audioContextState` in diagnostics; `iceTransportPolicy` applied to `RTCPeerConnection` |
| `src/utils/socket.js` | `reportConnectionError()` forwards handshake failures to `onError`; single-flight `refreshSession()`; `session:expired` recovery; `office:left` relay |
| `src/utils/auth.js` | `fetchIceServers()` returns `iceTransportPolicy` |
| `src/pages/VirtualOffice.jsx` | Disconnect clears `isInRoom` + real remote peers; applies ICE transport policy |

### Frontend tests
`src/__tests__/officeHarness.js` (`renderSettled`), `interaction.test.jsx`,
`render.test.jsx`, `persistence.test.jsx` (deterministic act flush / async mount);
`webrtc-cleanup.test.js` (+4 tests, now 23, including one that proves the
operational diagnostics distinguish an ICE failure from an audio-graph failure);
`socket-session.test.js` (new, 5).

### Backend source
| File | Change |
| --- | --- |
| `server/auth.js` | `AUTH_CODES.REVOKED`; `createRevocationStore()` |
| `server/config.js` | `parseTrustProxyHops()`, `isOriginAllowed()`, `isLoopbackOrigin()` |
| `server/server.js` | Live-socket expiry; revocation + `POST /api/auth/revoke`; Origin guard; HTTPS guard on token endpoints; `TRUST_PROXY` (fatal if invalid); security headers + HSTS; `office:leave` handler |
| `server/ice.js` | `ICE_TRANSPORT_POLICY` validation; `relay` without TURN is an error; policy in results |
| `server/mint-session.js` | **New** — `mintSession()` + CLI (IdP boundary) |
| `server/package.json` | `mint-session` script |

### Backend tests
`session-security.test.js` (new, 23), `mint-session.test.js` (new, 7),
`ice.test.js` (+4, now 16), `auth.test.js` (production tests updated for the
HTTPS guard).

### Docs / config
`PHASE4_FINAL_COMPLETION_REPORT.md`, `PHASE4_EXECUTION_LOG.md`,
`FINAL_HANDOFF.md` (root), `docs/PHASE4_{DEPLOYMENT,SECURITY,
OPERATIONS_RUNBOOK,ROLLBACK}.md`, `.env.example`, `server/.env.example`,
`docker-compose.yml`, `.github/workflows/ci.yml`, `README.md`.

---

## 6. Exact commands executed

```bash
# Baseline and regression
cd proxispeak && npx vitest run                     # frontend, run repeatedly
cd proxispeak/server && npx vitest run              # backend
cd proxispeak && npm run build                      # production build

# Targeted suites
cd proxispeak/server && npx vitest run session-security.test.js
cd proxispeak/server && npx vitest run mint-session.test.js
cd proxispeak/server && npx vitest run ice.test.js
cd proxispeak && npx vitest run src/__tests__/socket-session.test.js
cd proxispeak && npx vitest run src/__tests__/webrtc-cleanup.test.js

# Browser suites (backend on :4000 + `npx vite preview --port 4173 --host 127.0.0.1`)
npx playwright test --project=chromium-desktop
npx playwright test --project=chromium-mobile
npx playwright test tests/browser/webrtc-peer.spec.js tests/browser/webrtc-reliability.spec.js --project=chromium-desktop-fake-media

# Load (backend on :4100)
cd proxispeak/server && node load-test.js --url http://127.0.0.1:4100 --clients 20 --duration 10 --hz 5 --rooms 1
cd proxispeak/server && node load-test.js --url http://127.0.0.1:4100 --clients 50 --duration 15 --hz 2 --rooms 1

# Security / dependency / artifact checks
cd proxispeak && npm audit ; npm audit --omit=dev ; npm audit fix --dry-run
cd proxispeak/server && npm audit
grep -rEn "(SESSION_SECRET|TURN_SECRET|TURN_CREDENTIAL|HEALTH_TOKEN)[[:space:]]*[:=][[:space:]]*[\"'][^\"']+|proxispeak-development-only-session-secret|mongodb(\+srv)?://[^\"']*@" dist/
python -c "import yaml; yaml.safe_load(open('docker-compose.yml'))"     # compose YAML validity
```

Shell exit codes were preserved and inspected for every suite; output filters
were used only for summary lines.

---

## 7. Test results

| Suite | Passed | Failed | Skipped | Blocked / Not run |
| --- | --- | --- | --- | --- |
| Frontend unit/component (12 files) | **162** (5 consecutive runs, exit 0 each) | 0 | 0 | — |
| Backend unit/integration (10 files; 8 passed, 2 skipped) | **165** | 0 | 9 (gated) | — |
| — of which session security | 23 | 0 | 0 | — |
| — of which mint-session (IdP boundary) | 7 | 0 | 0 | — |
| — of which ICE/TURN config | 16 | 0 | 0 | — |
| Playwright desktop | 37 | 0 | 7 | — |
| Playwright mobile | 38 | 0 | 6 | — |
| Playwright fake-media WebRTC | 5 | 0 | 0 | — |
| Live MongoDB (6 tests) | — | — | — | **BLOCKED** — no `mongod`, Docker daemon not running |
| Mongo outage/recovery (2 tests) | — | — | — | **BLOCKED** — same dependency |
| Two-device audible audio | — | — | — | **NOT RUN** — no second device |
| Real TURN relay | — | — | — | **BLOCKED** — no TURN server/credentials |
| Browser-media scalability | — | — | — | **NOT RUN** |
| CI workflow | — | — | — | **NOT RUN** — no CI provider |
| `docker compose up -d mongo` | — | — | — | **NOT RUN** — daemon unavailable |
| Lint / type-check | — | — | — | **NOT AVAILABLE** — not configured |

Per-file breakdown of the frontend 162 (each file measured on its own; the twelve
sum to exactly 162):

| File | Tests | Covers |
| --- | --- | --- |
| `movement.test.js` | 26 | collision + movement resolution, boundaries, furniture sliding |
| `walking-path.test.js` | 25 | full walking paths around furniture (no stuck avatars, no through-geometry) |
| `proximity.test.js` | 19 | pixel distances, earshot membership, proximity strength |
| `audio-gain.test.js` | 6 | gain curve: 1.0 → 0.1 at the earshot edge → 0 beyond |
| `people.test.js` | 6 | roster + default positions free of furniture |
| `auth.test.js` (client) | 11 | session request, error mapping, ICE fetch helpers |
| `interaction.test.jsx` | 14 | real-DOM keyboard/drag/focus behaviour |
| `render.test.jsx` | 4 | rooms + furniture rendered at the collision rectangles |
| `persistence.test.jsx` | 19 | layout save/restore/reset + broken-storage handling |
| `microphone.test.jsx` | 4 | mic enable, mute, permission-denial messaging |
| `webrtc-cleanup.test.js` | 23 | peer lifecycle, glare, ICE buffering, cleanup, diagnostics |
| `socket-session.test.js` | 5 | session refresh, single-flight, auth-error surfacing |

The 9 backend skips are: 6 `db.live.test.js` (gated by `MONGODB_TEST_URI`),
2 `mongo-recovery.test.js` (gated by `PROXISPEAK_MONGO_RECOVERY=1`) and 1
pre-existing `it.skip` in `server.test.js` for a timing-sensitive polling
broadcast test that predates this work. No test was skipped by this execution.

---

## 8. Build and lint results

| Check | Command | Result |
| --- | --- | --- |
| Production build | `npm run build` | exit 0 — `dist/index.html` 0.46 kB; CSS 27.71 kB (6.91 kB gzip); JS 326.53 kB (100.66 kB gzip) |
| Bundle secret scan | value-based grep over `dist/` | no secret value found; the only occurrences of the identifier `SESSION_SECRET` are a UI error string |
| Lint | — | **NOT AVAILABLE** — neither `package.json` defines a lint script and no eslint/prettier/tsconfig exists. Nothing was added, because introducing a linter is a project-wide decision, not a Phase 4 fix |
| Type-check | — | **NOT AVAILABLE** — plain JavaScript project, no `tsconfig.json` |
| Dependency audit (server) | `npm audit` | 0 vulnerabilities |
| Dependency audit (frontend, runtime) | `npm audit --omit=dev` | 0 vulnerabilities |
| Dependency audit (frontend, all) | `npm audit` | 7 advisories (2 moderate, 5 high) in the Tailwind/PostCSS **build** chain; `npm audit fix --dry-run` reports the fix "Will install tailwindcss@4.3.3, which is a breaking change" |

---

## 9. Security findings and fixes

### Fixed in code (with tests)

1. **Session expiry enforced only at the handshake** → per-socket expiry timer,
   `session:expired`, then disconnect; client refreshes once. *(Test: "disconnects
   a socket when its token expires".)*
2. **No revocation** → `POST /api/auth/revoke` (bearer) adds the `jti` to a
   node-local list checked at the handshake and by `/api/ice`, and disconnects
   matching live sockets. *(Test: "revokes a session token and disconnects the
   live socket using it".)*
3. **No Origin validation** on state-changing requests → unlisted `Origin` gets
   `403 ORIGIN_FORBIDDEN`; absent `Origin` (curl/load tests) allowed;
   development accepts loopback origins on any port, production does not.
4. **Plaintext token issuance in production** → `/api/auth/session`,
   `/api/auth/revoke` and `/api/ice` require `req.secure` (`403 HTTPS_REQUIRED`).
5. **Ambiguous proxy trust** → `TRUST_PROXY` is a strictly validated hop count
   (0–3); names/wildcards exit 1; a forged `X-Forwarded-Proto: https` is ignored
   when no hop is declared. *(Test: "does not trust X-Forwarded-Proto when no
   proxy hop is configured".)*
6. **`office:leave` was a no-op server-side** → real leave: room exit, peers
   notified, `roomId`/`user` cleared, session-socket entry removed.
7. **Silent auth failures in the UI** → `connect_error` is forwarded to the
   caller's error handler.

### Verified as already correct (not changed)

Token signing/expiry/malformed-claim rejection with strict base64url and
constant-time compare; server-generated subject (no client-chosen identity);
timing-safe join-code comparison; per-event room checks on every room-scoped
event; directional offer tracking (a third socket cannot inject an answer);
payload caps (16 kB JSON, 256 kB Socket.IO, 64 kB SDP/ICE); rate limits (20
position/s per socket, 120 signalling/10 s, 240 session requests/min per IP);
`no-store` on token responses; security headers + HSTS; production health payload
carries no diagnostics or secrets; MongoDB URI redaction; no secret in the bundle;
no secret in logs (verified by a test that greps captured server output).

### Known security limitations (documented, not hidden)

- **No identity provider** — tokens identify a browser, not a person.
- **Revocation is node-local and in-memory** — not shared across instances, lost
  on restart; bounded by `exp`. Must be shared before scaling out.
- **`VITE_JOIN_CODE` is bundle-visible** — a weak gate, documented as such.
- **No per-user room ACL**; **P2P media is client-enforced**.
- **7 build-toolchain advisories** (Tailwind/PostCSS dev deps) — not shipped in
  `dist/`; fixable only via a breaking Tailwind 4 upgrade.
- Deliberate downgrade switches exist (`REQUIRE_HTTPS=false`,
  `PROXISPEAK_ALLOW_HTTP_ORIGIN=true`, `AUTH_ALLOW_ANONYMOUS=true`) and must not
  be used on an internet-facing deployment.

---

## 10. WebRTC/audio validation evidence

**Implemented and traced end to end:** mic gesture (which also unlocks the shared
`AudioContext`) → peer connection → offer/answer with perfect negotiation and
glare rollback → ICE candidate buffering/flush → `ontrack` → source → gain →
destination → `setTargetAtTime` proximity ramp (0.03 s, no clicks) → mute/unmute →
cleanup.

**Automated evidence (VERIFIED):**
- 23 client lifecycle tests in jsdom with a fake `RTCPeerConnection`,
  `AudioContext`, `GainNode` and `MediaStream`: single connection per peer, glare
  politeness both ways, ICE buffering, cleanup paths, one live audio sender across
  mic cycles, stale-graph teardown, ended-track detach, AudioContext ownership.
- 5 real-browser tests (Chromium fake media, **fake media is silent**): full peer
  lifecycle, repeated mic enable/disable cycles, socket-interruption reconnect +
  renegotiation, three peers keeping independent proximity gain.
- Gain function: 1.0 at 0 px → linear to 0.1 at the 100 px earshot edge → **0 at
  and beyond 100 px**; NaN/Infinity distances return 0.

**NOT RUN:** audible two-device audio, simultaneous speech, denied-permission
recovery on real hardware, device removal — no second device/microphone here.
The procedure remains in `PHASE4_TASK2_AUDIO_VALIDATION.md`. Fake media validates
logic and plumbing, **not physical sound**.

---

## 11. TURN/ICE validation evidence

- Configurable STUN/TURN from the environment; no credential is hardcoded or
  bundled. Ephemeral coturn-style credentials (`use-auth-secret`) are preferred;
  static credentials are supported with a warning; a weak secret is rejected.
- `/api/ice` serves credentials only to a verified, unrevoked session.
- `ICE_TRANSPORT_POLICY=relay` makes a relay-only verification run expressible and
  is applied to `RTCPeerConnection`; requesting `relay` without TURN is a
  configuration error (fatal in production) instead of a silent no-connect.
- 16 configuration tests pass (URL parsing, credential formula and expiry,
  weak-secret rejection, missing-credential error, transport-policy validation).
- **Real relay connectivity: BLOCKED — infrastructure unavailable.** No TURN
  server, hostname, or credential exists in this environment, and in this
  environment ICE resolves to STUN only (`turnEnabled: false`). No relay success is
  claimed. Verification steps (including confirming a `relay` candidate pair in
  `chrome://webrtc-internals`) are documented in `docs/PHASE4_DEPLOYMENT.md` and
  `docs/PHASE4_OPERATIONS_RUNBOOK.md`.

---

## 12. Signaling and browser-media performance results

Signaling only — the load script creates Socket.IO clients, **no peer
connections and no audio**.

| Clients | Duration / rate | Broadcasts/s | Position RTT p50 / p95 | Server RSS Δ | Server CPU (1 core) | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| 20 | 10 s @ 5 Hz | 1 862 | 7.61 / 15.00 ms | +380 KB | 5.6 % | 0 |
| 50 | 15 s @ 2 Hz | 4 736.7 | 59.96 / 111.31 ms | +1.6 MB | 16.9 % | 0 |

Both runs: 100 % acknowledgement rate, 80/80 signaling relays delivered
(p50 1 ms), no cleanup or connection failures. An earlier identical 50-client run
on this machine measured p50 38 ms / p95 65 ms, so treat absolutes as
machine-load sensitive; the invariants are 100 % acks and zero errors.

**Architectural boundary (honest capacity model):** the mesh is O(n²) peer
connections — 4 peers = 6 connections, 10 peers = 45, 20 peers = 190 — and each
connection carries its own audio encode/decode plus proximity gain work in every
browser. Server signaling is demonstrably cheap; **browser media is the binding
constraint**. Realistic boundary for this design: ~4–6 participants per room on
ordinary laptops with upstream audio bandwidth of roughly `(n−1) × ~40 kbps` per
client. Beyond that, replace the mesh with an SFU (LiveKit/mediasoup) — that is a
documented upgrade path, not a Phase 4 change. **50 signaling clients is not
evidence of 50 concurrent audio users.** Browser-media scalability: **NOT RUN**.

---

## 13. Deployment instructions

Full detail in `docs/PHASE4_DEPLOYMENT.md`; the shortest correct path:

```bash
# Backend
cd server && npm ci
NODE_ENV=production \
CLIENT_ORIGIN=https://proxispeak.example.com \
SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" \
TRUST_PROXY=1 \
JOIN_CODE='<at least 12 chars>' \
node server.js

# Frontend
npm ci && npm run build          # serve dist/ from the same origin as /api
```

- Serve `dist/` and proxy `/api` **and** `/socket.io` from one origin; the app
  speaks plain HTTP and expects TLS termination at that proxy (`TRUST_PROXY` = hop
  count, e.g. `1`).
- Startup fails closed (`exit 1`) on: missing/invalid `CLIENT_ORIGIN`, missing or
  short `SESSION_SECRET`, invalid `TRUST_PROXY`, TURN misconfiguration, or
  `relay` without TURN.
- Health: `GET /api/health` (aggregate only in production; optional
  `HEALTH_TOKEN`). MongoDB is optional and self-healing.
- Smoke checklist, rollback triggers/procedure and incident playbooks:
  `docs/PHASE4_DEPLOYMENT.md`, `docs/PHASE4_ROLLBACK.md`,
  `docs/PHASE4_OPERATIONS_RUNBOOK.md`. Local commands and troubleshooting:
  `FINAL_HANDOFF.md`.
- **No deployment was performed**, and no account, purchase, or external
  infrastructure change was made.

---

## 14. Remaining limitations and external dependencies

| # | Dependency | Blocks | Exact next action |
| --- | --- | --- | --- |
| 1 | TURN server + credentials | Real relay verification | Set `TURN_URLS`/`TURN_SECRET`, restart, confirm `turnEnabled: true`, run `ICE_TRANSPORT_POLICY=relay`, confirm a `relay` candidate pair |
| 2 | Two devices with microphones | Audible audio acceptance | Run `PHASE4_TASK2_AUDIO_VALIDATION.md` |
| 3 | MongoDB (`mongod` or Docker) | 8 gated tests | `docker compose up -d mongo`, then the two gated commands in `FINAL_HANDOFF.md` §4 |
| 4 | Identity provider | Human identity | Call `mintSession()` from your issuer (`server/mint-session.js`); disable the development issuer |
| 5 | Second instance + shared store | Safe horizontal scaling | Socket.IO adapter + shared revocation/room state |
| 6 | CI provider | Automated gates | Push the repo; `.github/workflows/ci.yml` runs both suites, the build and the secret scan |
| 7 | Physical network variety | NAT/firewall behaviour | Test from two different networks (mobile hotspot vs office LAN) |

---

## 15. Known risks and severity

| Risk | Severity | Evidence | Remediation |
| --- | --- | --- | --- |
| No identity provider; sessions are not people | **High** | `docs/PHASE4_SECURITY.md` §1 | Integrate an IdP via `mintSession()` |
| Physical audio never validated | **High** | §10 — fake media is silent | Two-device manual pass |
| Real TURN relay unverified | **High** | §11 — no TURN available | Configure and verify with `ICE_TRANSPORT_POLICY=relay` |
| Browser-media capacity unmeasured | **High** | §12 — signaling only | Bounded multi-browser test; SFU beyond ~4–6 peers |
| Mesh topology caps room size | **High** (by design) | §12 capacity model | SFU for larger rooms |
| Revocation is node-local, lost on restart | Medium | `createRevocationStore()` | Shared store or edge revocation; keep TTLs short (default 1 h) |
| `VITE_JOIN_CODE` bundle-visible | Medium | `src/utils/auth.js` | Prefer upstream issuance; rotate the code |
| Deliberate downgrade switches | Medium | `server/.env.example` | Never on internet-facing deployments |
| 7 build-toolchain advisories | Low | `npm audit` | Accepted: dev-only, not in `dist/`; fix requires Tailwind 4 |
| No lint/type-check tooling | Low | §8 | Add ESLint (+`tsconfig` checkJs) as a separate, deliberate change |
| No committed baseline (zero commits) | Low | `git status` — all untracked | Make an initial commit so future regressions can be diffed |
| Rollback never exercised against a live deployment | Medium | `docs/PHASE4_ROLLBACK.md` is procedure only | Rehearse once in the target environment |

---

## 16. Release verdict

### **COMPLETE FOR LOCAL DEVELOPMENT**

Supported by evidence: frontend 162 tests passing across 5 consecutive runs with
zero warnings; backend 165 passing with only gated/pre-existing skips; clean
production build and secret scan; desktop/mobile/fake-media browser suites green;
bounded 20/50-client load runs at 100 % acks and zero errors; the full
audio/session/room path implemented, traced and covered by automated tests; and
complete deployment, security, operations, rollback, test-matrix and handoff
documentation. `npm run dev` + `npm run dev` (server) gives a working office with
proximity audio on localhost.

### Secondary assessment: **READY FOR CONTROLLED PILOT — with conditions**

Code-complete for a pilot, provided the operator: deploys with a real HTTPS
origin, `SESSION_SECRET`, a join code and `TRUST_PROXY`; keeps the downgrade
switches off; completes the two-device audio pass; configures TURN if peers sit
behind restrictive NATs; and accepts the documented identity gap (no IdP) with
short TTLs.

### **NOT production-ready.** Blocking items

1. no identity provider — tokens identify a browser, not a person;
2. audible two-device audio never validated;
3. real TURN relay never validated;
4. browser-media capacity at real concurrency never measured, and the O(n²) mesh
   caps practical room size (~4–6);
5. revocation and room state are process-local, which blocks safe horizontal
   scaling;
6. the rollback plan has never been rehearsed in a real environment.

The remaining gaps are external dependencies and validation work, not hidden code
defects: nothing in this report was marked verified without a command behind it.
