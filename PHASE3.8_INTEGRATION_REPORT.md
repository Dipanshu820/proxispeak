# ProxiSpeak Phase 3.8 — Real-Environment Integration Validation

**Date:** October 18, 2026
**Overall status:** `PARTIALLY VERIFIED`

Sub-area statuses (details and evidence in each section):

| Area | Status |
|---|---|
| WebRTC offer / answer / ICE relay + authorization | VERIFIED (automated, real server) |
| Client peer lifecycle + cleanup | VERIFIED (automated, fake RTCPeerConnection) |
| Proximity gain math and its wiring to the audio graph | VERIFIED (automated; curve is deterministic) |
| Real microphone capture + audible remote playback | **UNVERIFIED** — no microphone in this environment; manual procedure in §3.5 |
| Live MongoDB (connection, indexes, persistence, `$geoWithin`) | VERIFIED against `mongo:7` in Docker |
| Graceful behavior when MongoDB is unavailable | VERIFIED (real process + HTTP probe) |
| Server-side room membership for presence / movement / signaling | VERIFIED |
| Authenticated identity / room access control | **NOT IMPLEMENTED** — documented gap + plan (§5.3) |
| Production CORS / startup guard (nonzero exit) | VERIFIED (shell exit codes + child-process tests) |
| Production build | VERIFIED |
| 50+ concurrent users | **NOT CLAIMED** — no load test was run |

Phase 3.7 behavior was preserved. No previously passing test was weakened to make this report green; where a test needed attention it was fixed at the cause. One test encoded a **wrong contract** and was replaced — the details and the reason are in §3.1.

---

## 1. Changes and files modified

### 1.1 Server

| File | Change |
|---|---|
| `server/config.js` | **New.** Side-effect-free configuration helpers: `validateClientOrigin()` (production origin guard), `sanitizeDisplayName()`, `MAX_DISPLAY_NAME_LENGTH`. Split out so the guards can be unit tested without booting Express/Socket.io. |
| `server/server.js` | Uses `config.js`. Production startup now fails closed on a **missing**, **wildcard**, **malformed**, **non-http(s)**, or **path-bearing** `CLIENT_ORIGIN` (previously only the left-at-default value was rejected). Display names from `office:join` are normalized with `sanitizeDisplayName()`; identity stays bound to the server-assigned `socket.id`. |
| `server/webrtc.js` | **`webrtc:accept` could never succeed**, so no WebRTC handshake could complete (see §3.1). It required `socket.id === fromSocketId`, but the client sends the id of the **initiator it is answering** (the invite's `from`), so every real answer was rejected with `INVALID_REQUEST`; the next guard would also have failed because it looked up state for `socket.id:socket.id`, which is never recorded. Fixed to the only consistent contract: `fromSocketId` is the initiator, the server requires a recorded offer **from** that socket **to** the answerer, rejects self-answers, then relays `webrtc:accepted` to the initiator. `webrtc:initiate` now requires the emitter to be in a room and the target to be in **the same room** (`NOT_IN_SAME_ROOM`). `webrtc:ice-candidate` now applies the same room check to emitter and target (previously any socket could relay ICE candidates to any other connected socket). Also repaired a corrupted header line where a dead `import` had been glued onto a comment (commented-out code, no runtime effect, but wrong). |
| `server/db.js` | **Three real defects found by the live database run** (see §4.3): the proximity query filtered on `location` instead of the indexed `location.geometry`; the GeoJSON polygon was passed to `$geoWithin` without the required `$geometry` wrapper; `updateUserPosition()` wrote `location.officeId` but never the top-level `officeId` the queries filter on. Also made `getOnlineUsersInOffice()` tolerate a document with no location. |
| `server/vitest.config.js` | `include: ['*.test.js']` so new test files are picked up (was a hard-coded list of three files). |

### 1.2 Client

| File | Change |
|---|---|
| `src/utils/webrtc.js` | **Proximity audio was never actually wired** — see §3.2. Fixed: exported `proximityGain(distancePx)` and made `updateProximityVolume()` use it; documented that its coordinates are **pixels**; one shared `AudioContext` created inside the mic-enable user gesture and resumed when a remote track arrives (instead of `new AudioContext()` per track, which starts suspended and plays nothing); per-peer `MediaStreamAudioSourceNode` tracked and disconnected on cleanup **without** closing the shared context (closing it would silence every other peer); `presence:left` now cleans up that peer (previously an empty loop body); `ontrack` uses `event.track`; `setRemoteDescription`/`addIceCandidate` rejections are handled; gain changes ramp with `setTargetAtTime` (no clicks while dragging). |
| `src/pages/VirtualOffice.jsx` | Added the missing effect that converts both avatars' percentage positions to pixels (`pctToPixels`) and applies `updateProximityVolume()` for every remote peer on every position/floor-size change. This is what turns avatar distance into audio gain. Updated stale UI copy that still said remote audio was "coming in Phase 3.4" and that proximity strength was "visual only". |

### 1.3 Tests added

| File | Tests | What it covers |
|---|---|---|
| `server/webrtc.test.js` | +7 (now 24: 9 proximity + 15 signaling) | Full **offer → invite → answer → accepted** transition; `webrtc:initiate` relays in-room and is rejected cross-room; `webrtc:ice-candidate` relays in-room (payload shape preserved) and is rejected cross-room and when the sender never joined a room; self-answers rejected; answers injected by a third socket rejected; answer rejected after the answerer rejoins another room. |
| `server/startup.test.js` | **new**, 17 | 8 `validateClientOrigin` cases, 4 `sanitizeDisplayName` cases, and 5 **real child-process** cases that assert the actual exit code of `node server.js`. |
| `server/db.live.test.js` | **new**, 6 (gated) | Live connection, index creation, persistence across a reconnect, unique-email enforcement, virtual-coordinate mapping, real `$geoWithin` proximity query scoped to an office. Skipped unless `MONGODB_TEST_URI` is set. |
| `src/__tests__/audio-gain.test.js` | **new**, 6 | Client proximity gain curve + integration with `pctToPixels`/`pixelDistance` on a 900×540 floor. |
| `src/__tests__/webrtc-cleanup.test.js` | **new**, 9 | Peer creation and emitted `webrtc:offer`, de-duplication, disconnected-socket no-op, `cleanupPeerConnection`, `cleanupAllPeers`, cleanup on `webrtc:peer-disconnected`, cleanup on `presence:left`, unknown-peer no-op, `destroy()` removing listeners. |

No browser spec, and no pre-existing unit test, was changed to make a result green. `tests/browser/multi-user.spec.js` is byte-identical to its Phase 3.7 content (an exploratory assertion relaxation made during this phase was reverted — the unmodified test passes once the backend is actually running, see §6).

---

## 2. Exact commands and results

All commands were run from `proxispeak` unless stated otherwise, on Windows with Git Bash, Node v24.18.0.

### 2.1 Backend tests (hermetic — no live database)

```bash
cd proxispeak/server && npx vitest run
```
```
Test Files  4 passed | 1 skipped (5)
     Tests  64 passed | 7 skipped (71)
```
- `server.test.js`: 14 passed, 1 skipped (pre-existing skip: cross-client broadcast over the HTTP-polling transport).
- `webrtc.test.js`: 24 passed (9 proximity + 15 signaling).
- `db.test.js`: 9 passed.
- `startup.test.js`: 17 passed.
- `db.live.test.js`: 6 skipped (gated, see §2.2).

### 2.2 Backend tests against a live MongoDB

```bash
docker run -d --name proxispeak-mongo-test -p 27018:27017 mongo:7
cd proxispeak/server && MONGODB_TEST_URI=mongodb://127.0.0.1:27018 npx vitest run db.live.test.js
```
```
✓ db.live.test.js (6 tests) 336ms
Test Files  1 passed (1)
     Tests  6 passed (6)
```

### 2.3 Frontend tests

```bash
cd proxispeak && npx vitest run --pool=forks
```
```
Test Files  10 passed (10)
     Tests  132 passed (132)
```
(117 pre-existing + 6 audio-gain + 9 webrtc-cleanup.)

### 2.4 Production build

```bash
cd proxispeak && npm run build
```
```
dist/index.html                   0.46 kB │ gzip:  0.30 kB
dist/assets/index-DKlru1sE.css   27.71 kB │ gzip:  6.91 kB
dist/assets/index-bsR49v8W.js   318.80 kB │ gzip: 98.18 kB
✓ built in 2.49s
```

### 2.5 Production startup / CORS guard — real shell exit codes

```bash
cd proxispeak/server
NODE_ENV=production PORT=4330 node server.js; echo "exit_code=$?"
NODE_ENV=production PORT=4331 CLIENT_ORIGIN='*' node server.js; echo "exit_code=$?"
NODE_ENV=production PORT=4332 CLIENT_ORIGIN='not-a-url' node server.js; echo "exit_code=$?"
NODE_ENV=production PORT=4333 CLIENT_ORIGIN='http://localhost:5173' node server.js; echo "exit_code=$?"
```
```
== 1) production, no CLIENT_ORIGIN ==          exit_code=1
== 2) production, CLIENT_ORIGIN='*' ==         exit_code=1
== 3) production, CLIENT_ORIGIN=not-a-url ==   exit_code=1
== 4) production, default dev origin ==        exit_code=1
```
stderr in each case (abridged):
```
FATAL: CLIENT_ORIGIN is not configured for production. Set CLIENT_ORIGIN to your frontend URL (e.g. https://proxispeak.example.com).
FATAL: CLIENT_ORIGIN must not contain a wildcard. ...
FATAL: CLIENT_ORIGIN is not a valid absolute URL. ...
FATAL: CLIENT_ORIGIN is not configured for production. ...
```
The same behavior is asserted automatically by `startup.test.js`, which spawns the real entrypoint and checks `code === 1` and that the process never logged `listening`. The matching positive cases also run there: `NODE_ENV=production` + a valid `https` origin starts and logs `ProxiSpeak server listening`; `NODE_ENV=development` with the default origin starts.

### 2.6 Development configuration still works

```bash
cd proxispeak/server && PORT=4000 node server.js
```
```
ProxiSpeak server listening at http://localhost:4000
health: {"ok":true,"service":"proxispeak-server","port":4000,"mongodb":"disabled"}
```

---

## 3. Task 1 — Real WebRTC audio

### 3.1 Signaling flow (verified)

Client (`src/utils/webrtc.js`) → server (`server/webrtc.js`):

1. `initiatePeerConnection(remoteId)` creates the `RTCPeerConnection` (local mic tracks added when the mic is on), `createOffer()` → `setLocalDescription()` → `emit('webrtc:offer', { targetSocketId, sdp })`.
2. Server `webrtc:offer`: validates target and SDP → 64 KiB cap → emitter must be in a room → target must be online → **target must be in the same room** → records `offer`/`answer` state for the pair → forwards `webrtc:invite { from, sdp, roomId, userId, userName }`.
3. `handleInvite()` stores the pending invite and, because the invite carries `sdp`, immediately calls `acceptPeerConnection(from, sdp)`: `setRemoteDescription(offer)` → `createAnswer()` → `setLocalDescription(answer)` → `emit('webrtc:accept', { fromSocketId, sdp })`.
4. Server `webrtc:accept`: 64 KiB cap → reject self-answer (`socket.id === fromSocketId`) → **a recorded offer from `fromSocketId` to this socket must exist** (`NO_SIGNALING_STATE` otherwise) → same-room check between answerer and initiator → forwards `webrtc:accepted { from: <answerer>, sdp, roomId }` to the initiator (`fromSocketId`).

   *This handler was broken before this phase:* it asserted `socket.id === fromSocketId`, i.e. it treated `fromSocketId` as "who I am". The client (`acceptPeerConnection(from, sdp)`) sends `from` from the invite, which is the **initiator**, so every real answer was rejected and no peer could ever reach `connected`. The old unit test named "rejects webrtc:accept when the sender impersonates another socket" encoded that wrong contract; it has been replaced by tests of the correct one (self-answer rejected, third-party injection rejected, recorded-offer required) plus the missing happy-path transition test. The corrected behavior is what the client already expected, so no client change was needed.
5. `handleAccepted()` → `setRemoteDescription(answer)` (rejections now handled).
6. ICE: `pc.onicecandidate` → `emit('webrtc:ice-candidate', { targetSocketId, candidate })`; server applies the payload cap and the same-room check, then relays with `{ from, candidate, sdpMid, sdpMLineIndex }`; `handleIceCandidate()` → `addIceCandidate()`.

Cleanup:
- `webrtc:peer-disconnected` → `cleanupPeerConnection(from)`.
- `presence:left` → `cleanupPeerConnection(userId)` (added: a socket that joins another room never emits `peer-disconnected`).
- `pc.onconnectionstatechange` → cleanup on `disconnected`/`failed`.
- Server `disconnect` → closes its peer map entries, notifies the remote socket, and deletes every `signalingState` key touching the socket id.
- `destroy()` → removes all socket listeners and closes every peer.

Reconnection: the socket client reconnects (10 attempts, 1–5 s backoff); `VirtualOffice` re-joins on `connect` and re-fetches `presence:list`. Peer connections are re-initiated by the client when the mic is enabled / the roster changes. In-progress media does **not** resume automatically across a hard disconnect — accepted for a small-room prototype and called out in §7.

Known collision (glare): both sides initiate when each enables its microphone, so two offers can cross for the same pair. The side that already holds a local offer fails `setRemoteDescription`, logs it and drops the peer; there is no perfect-negotiation tie-break. Listed as a limitation, not fixed here.

### 3.2 Proximity volume now uses the actual avatar distance — and is actually connected

Two defects were found by inspection and are fixed:

1. **`updateProximityVolume()` was imported by `VirtualOffice.jsx` but never called.** The gain node created for a remote track started at `0` and nothing ever changed it, so remote participants would have been permanently inaudible even with working microphones. The report for Phase 3.7 described the function; it did not describe it being called. It is now driven by an effect that runs on every `people` / `floorSize` change:

```js
const localPx = pctToPixels(me.x, me.y, floorSize.width, floorSize.height)
const remotePx = pctToPixels(person.x, person.y, floorSize.width, floorSize.height)
updateProximityVolume(person.id, localPx.x, localPx.y, remotePx.x, remotePx.y)
```

2. **Unit mismatch.** The function computed `sqrt(dx²+dy²)` over percentage coordinates while the configured earshot (`EARSHOT_RADIUS_PX = 100`) is in pixels. Both sides now use pixels, so a distance of 100 in the app means 100 CSS pixels on the measured floor — the same number the earshot ring and the colleagues panel show.

The curve (`proximityGain`) is 1.0 at distance 0, linear to `minVolume (0.1)` just inside `earshotPx`, and exactly 0 at or beyond it. Verified by automated tests on both sides of the wire:

- `server/webrtc.test.js` — 9 tests, including a 900×540 floor case (50 %,50 % → 70 %,50 % = 180 px → gain 0) and the linear-falloff ordering test.
- `src/__tests__/audio-gain.test.js` — 6 tests, including 50 %,50 % → 55 %,50 % on the same floor = 45 px → gain 0.595, and a 200 px peer → gain 0.

### 3.3 Microphone permission, muted state, autoplay

- **Permission:** `requestMic()` calls `navigator.mediaDevices.getUserMedia({ audio: true })`. On denial/rejection `toggleMic()` catches and shows "Microphone access failed. Use localhost/HTTPS and allow permission."; the meter stays 0 and no peer connection is started. Covered by `src/__tests__/microphone.test.jsx` (4 tests, including "no microphone API").
- **Muted state:** `toggleMute()` sets `track.enabled = !muted` on every local audio track and reports `speaking:update` to the server. Mute is a **local media-track state**; it is not server-enforced and does not cut the remote side's playback by itself. The UI meter reads `track.enabled`, so it drops to 0 while muted.
- **Autoplay:** browsers start an `AudioContext` suspended unless it is created/resumed inside a user gesture. The context is now created in `requestMic()` (a real click on "Enable mic") and `resume()`d when a remote track arrives; if it is still suspended the client logs a warning instead of silently playing nothing. Previously a fresh `AudioContext` was created on `ontrack`, i.e. outside any gesture, which Chrome would leave suspended.
- **Playback graph:** `MediaStreamSource → GainNode → destination`, gain initial value 0, updated from `proximityGain`. Gains ramp with `setTargetAtTime(..., 0.03)` so dragging does not click.

### 3.4 Why real audio is still only PARTIALLY VERIFIED

The automated tests above prove the **signaling contract, the bookkeeping, the cleanup paths and the gain curve**. They do not prove that a human voice is captured and heard: that needs `getUserMedia` with real hardware and two independent playback devices. The `chromium-desktop-fake-media` Playwright project uses Chrome's fake device, which produces **silence** and has no CLI switch for a test tone, so it cannot show meter movement or audible playback either. Nothing in this report claims real audio works on the strength of signaling tests.

### 3.5 Manual two-session Windows Chrome procedure (real audio)

Prerequisites:

```bash
# Terminal 1 — backend
cd proxispeak/server && PORT=4000 node server.js

# Terminal 2 — built frontend
cd proxispeak && npm run build && npx vite preview --port 4173 --host 127.0.0.1
```

Use **headphones** for both sessions. Without them the two microphones will feed back.

Open two genuinely independent Chrome sessions (separate profiles ⇒ separate cookie/socket namespace and separate microphone grants):

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir=%TEMP%\proxispeak-a --new-window http://localhost:4173
"C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir=%TEMP%\proxispeak-b --new-window http://localhost:4173
```

1. **Join the same room.** In both windows click **Enter Office**. The app joins `design-team` automatically. Each window should show `● CONNECTED`, `Real-time with 1 remote`, and the other participant in the colleagues panel marked **Live** (not "demo").
2. **Grant the microphone.** In Session A click **Enable microphone** → Chrome shows the permission prompt (right side of the address bar) → **Allow**. If no prompt appears, hard-block is likely: open `chrome://settings/content/microphone`, remove `http://localhost:4173` from "Not allowed", reload and retry. Do the same in Session B.
3. **Confirm session health.** In each window: the header pill shows a live WebRTC state (not `WEBRTC PENDING`), and DevTools → Console contains `WebRTC: connection state for <id>: connected`. In DevTools console check autoplay is fine: `new AudioContext().state` should not be needed — instead confirm the app's context is running by the audible result in step 4.
4. **Both directions.** Speak into A's microphone — you should hear it in B, and vice versa. If you hear nothing in one direction only, that side's mic was denied or its `AudioContext` is suspended (Console shows `audio context still suspended`).
5. **Proximity.** In Session A drag your avatar (or hold WASD/arrows) toward B's avatar. Inside the 100 px earshot ring the remote voice should become audible and get louder as you approach; drag away and it fades to silence at the ring edge. Verify the same in the reverse direction. Cross-check the panel: "Nearest colleague … px away" and "Proximity strength %" should fall/rise in step with the audible change.
6. **Mute.** In Session A click **Mute microphone** → A's local meter drops to 0 and B stops hearing A. Click **Unmute** → audio returns. A's own proximity audio from B must keep working while A is muted.
7. **Disconnect.** Close Session A entirely. Session B should drop A's avatar and panel row, and `Real-time with 0 remote` should appear. No console errors in B.
8. **Reconnect.** Reopen Session A at `http://localhost:4173`, click **Enter Office**, enable the mic again. B sees exactly one A (no ghost), A hears B, and the proximity behavior from step 5 still holds.
9. **Permission-denied path.** In Session A: `chrome://settings/content/microphone` → block `http://localhost:4173`, reload, click **Enable microphone**. Expect the toast "Microphone access failed. Use localhost/HTTPS and allow permission.", meter stuck at 0, and no peer connection created. Unblock afterwards.
10. **Optional signaling inspection.** DevTools → Network → WS → the `socket.io` frames should show `webrtc:offer` → `webrtc:invite` → `webrtc:accept` → `webrtc:accepted` and `webrtc:ice-candidate` in both directions.

---

## 4. Task 2 — Live MongoDB

### 4.1 Environment variables

| Variable | Required? | Meaning |
|---|---|---|
| `MONGODB_URI` | No | Enables persistence. Example: `mongodb://localhost:27017/proxispeak`. Leave unset and the server runs in-memory only. |
| `MONGODB_TEST_URI` | No | **Test-only.** Enables `server/db.live.test.js`. Never read by the application. |
| `PORT` | No | Default `4000`. |
| `NODE_ENV` | No | `development` / `test` / `production`. Only `production` activates the CORS guard. |
| `CLIENT_ORIGIN` | Production: yes | Allowed frontend origin for CORS, used by both Express and Socket.io. |

Credentials belong in `MONGODB_URI` (or the environment of your process manager), never in source, and `.env` must not be committed (`server/.env.example` documents the variables only).

### 4.2 Real setup used for verification

```bash
docker run -d --name proxispeak-mongo-test -p 27018:27017 mongo:7
```
```
proxispeak-mongo-test  Up  0.0.0.0:27018->27017/tcp
```
This is a genuine `mongod` (MongoDB 7), not an in-memory fake. Port 27018 was used so an existing local 27017 instance would not be disturbed.

### 4.3 What the live run proved (`server/db.live.test.js`, 6/6)

1. **Connection** to a real server; `getDb().databaseName` matches the throwaway database.
2. **Indexes really created:** unique `users.email`, `users['location.geometry']` **2dsphere**, unique `offices.slug`, `sessions {userId, officeId, startedAt}`.
3. **Persistence + retrieval:** insert user/office, `disconnect()` the client, `connect()` again, read the same documents back — so the data is in the database, not process memory.
4. **Unique constraint enforced** by the server (duplicate email insert rejects).
5. **Virtual coordinates** stored in the 0–100 % mapping (50 %,50 % → virtual `[0, 0]`), with the public round-trip returning 50/50, never degrees.
6. **Real `$geoWithin` query:** Alice (50,50), Bob (55,50) and Carol (90,90) in office A, Dave (50,50) in office B. Query at (50,50) radius 10 % returns **Alice and Bob**, excludes **Carol** (out of the box) and **Dave** (different office), with `position` back in percentages and `distancePercent ≈ 5` for Bob.

Server-level integration with the same database (real process, real HTTP):

```
health: {"ok":true,"service":"proxispeak-server","port":4320,"mongodb":"connected"}
socket.io handshake status: 200
ProxiSpeak server listening at http://localhost:4320
Connected to MongoDB: mongodb://127.0.0.1:27018/proxispeak_smoke/proxispeak
```

### 4.4 Graceful behavior when MongoDB is unavailable

Same server, with `MONGODB_URI=mongodb://127.0.0.1:1/proxispeak` (nothing listening):

```
health: {"ok":false,"service":"proxispeak-server","port":4321,"mongodb":"error","error":"MongoDB connection failed"}
socket.io handshake status: 200
```
The process keeps serving HTTP and Socket.io; `ok:false` + `mongodb:"error"` distinguishes "configured but broken" from `mongodb:"disabled"` (not configured). Covered automatically by `server.test.js` (health with no URI) and by the manual probe above.

### 4.5 Virtual-office coordinates stay separate from real lon/lat

- Office positions are 0–100 % of the floor.
- `positionToGeoJSON()`/`geoJSONToPosition()` are the only bridge, and they map to a **virtual** space (`lng ∈ [-180, 180]`, `lat ∈ [-90, 90]`). That space exists solely so MongoDB's 2dsphere index has a coordinate system.
- No real latitude/longitude is stored or requested anywhere; the code comment says so explicitly, and the live test asserts the stored values are the virtual mapping of percentages.

### 4.6 Exact Windows commands to reproduce

`cmd.exe`:
```bat
docker run -d --name proxispeak-mongo-test -p 27018:27017 mongo:7
set MONGODB_TEST_URI=mongodb://127.0.0.1:27018
cd proxispeak\server
npx vitest run db.live.test.js

set MONGODB_URI=mongodb://127.0.0.1:27018/proxispeak
npm start
:: other terminal
curl http://localhost:4000/api/health
```
Git Bash:
```bash
docker run -d --name proxispeak-mongo-test -p 27018:27017 mongo:7
cd proxispeak/server
MONGODB_TEST_URI=mongodb://127.0.0.1:27018 npx vitest run db.live.test.js
MONGODB_URI=mongodb://127.0.0.1:27018/proxispeak PORT=4000 node server.js
curl -s http://localhost:4000/api/health
```
Cleanup: `docker rm -f proxispeak-mongo-test`.

Without Docker, install MongoDB Community Server, run `mongod --dbpath <path>` (default port 27017) and use `mongodb://127.0.0.1:27017` as the URI.

---

## 5. Task 3 — Identity and production security

### 5.1 Which identity fields come from untrusted client input

| Field | Origin | Trusted? |
|---|---|---|
| `socket.id` | Socket.io, server-generated | **Yes** — the only wire identity |
| `socket.data.user.id` | Set to `socket.id` by the server in `office:join` | Yes |
| `socket.data.user.name` | Client payload `office:join({ user:{ name } })` | **No** — display text only. Now normalized (control chars stripped, whitespace collapsed, 40-char cap, `"Guest"` default) |
| `socket.data.roomId` | Validated non-empty string from the client, stored server-side | Membership is server-side, but **any socket may join any room** (see §5.3) |
| Position / speaking payloads | Client | Untrusted content; validated, clamped to 0–100, rate-limited (20/s) |
| `userName` / `userId` in `webrtc:invite` | Derived server-side from the emitting socket | Yes for `userId` (= socket id); `userName` is the untrusted display name |

Impersonation that is **not** possible: publishing a position, speaking state, offer, answer or ICE candidate **as another socket**. Those handlers never read a client-supplied participant id — they use `socket.id` (and `webrtc:accept` explicitly rejects `fromSocketId !== socket.id`).

Impersonation that **is** possible today: choosing any display name, including another person's or "Admin", and joining any room id. Both are presentation/authorization gaps, not identity forgery at the protocol level.

### 5.2 What is enforced server-side (verified by tests)

1. `position:update` / `speaking:update` are ignored unless `socket.data.roomId` is set.
2. All presence/movement/speaking broadcasts use `socket.to(roomId)` — they never cross rooms.
3. `webrtc:offer`, `webrtc:accept`, **`webrtc:initiate`** and **`webrtc:ice-candidate`** all require emitter and target to share `socket.data.roomId` (`NOT_IN_SAME_ROOM` otherwise). The two newly guarded events were previously open to any connected socket, which leaked invitations and ICE candidates (host/srflx addresses) across rooms.
4. `webrtc:accept` impersonation guard (`socket.id === fromSocketId`).
5. `webrtc:accept` signaling-state guard (`NO_SIGNALING_STATE` without a recorded pair).
6. 64 KiB payload cap on SDP and ICE candidates.
7. Rate limit on position updates.
8. Display-name normalization (new).

### 5.3 What is **not** solved — authenticated identity and room access control

`office:join` accepts any non-empty `roomId` from any connected client. There is no account, token, invite, or ACL. So: anyone who can reach the socket endpoint can join any room and pick any display name. The guards above constrain what a *connected* socket may do, not *who may connect*.

The smallest safe step that fits this architecture (recommended, **not implemented** here, because it is a product/auth decision and a larger change than this phase's scope):

1. Issue a signed, short-lived join ticket from an HTTP endpoint (or an existing identity provider) and require it in the Socket.io handshake (`auth.token`).
2. On connection, verify the ticket and bind `socket.data.user.id`/`name` to the verified subject; ignore any client-supplied `name` when a verified profile exists.
3. Keep room ids as-is for public rooms; for private rooms, check a server-side membership table (MongoDB is already available) inside `office:join`.
4. Keep every guard in §5.2 — they remain necessary after authentication.
5. Do not expose this build publicly before 1–3; the health endpoint should also be removed or protected in production.

### 5.4 Production CORS / startup guard

`server/config.js:validateClientOrigin()` runs at startup when `NODE_ENV=production` and rejects: missing/default origin, any `*`, non-absolute URL, non-`http(s)` scheme, and an origin carrying a path/query/fragment. `server/server.js` prints `FATAL: …` and `process.exit(1)` before binding a port. Measured exit codes are in §2.5, and the same cases run as real child-process tests in `server/startup.test.js`. Development and test configuration is unaffected (`validateClientOrigin` returns `null` when `NODE_ENV !== 'production'`), confirmed by the passing dev-start test and the full test suite.

---

## 6. Final evidence summary

| Check | Command | Result |
|---|---|---|
| Backend (hermetic) | `cd server && npx vitest run` | 64 passed, 7 skipped, exit 0 |
| Backend (live Mongo) | `MONGODB_TEST_URI=… npx vitest run db.live.test.js` | 6 passed, exit 0 |
| Frontend | `npx vitest run --pool=forks` | 132 passed (10 files), exit 0 |
| Build | `npm run build` | success, 318.80 kB JS / 98.18 kB gzip |
| E2E desktop | `npx playwright test --project=chromium-desktop` | **37 passed, 2 skipped**, exit 0 |
| E2E mobile | `npx playwright test --project=chromium-mobile` | see limitation below |
| CORS guard | 4 shell commands + 5 child-process tests | exit code 1 in every bad-config case |
| Live Mongo server probe | health + Socket.io handshake | `mongodb:"connected"`, handshake 200 |
| Mongo unavailable probe | health + Socket.io handshake | `mongodb:"error"`, `ok:false`, handshake 200 |

E2E prerequisites actually used: backend on `:4000` (`node server.js`) and `vite preview` on `:4173` serving the **freshly built** bundle (verified the served asset hash matched `dist/assets/index-*.js`).

After the final `webrtc:accept` fix the multi-user spec was re-run against the rebuilt server: `npx playwright test --project=chromium-desktop -g "Multi-User"` → 4 passed (8.3 s), so socket connect, presence sync and disconnect cleanup are unaffected. The full desktop run predates that fix by minutes; no E2E test enables a microphone, so `webrtc:accept` is not exercised there at all — it is covered by the backend signaling tests in §2.1 and §3.1.

**Mobile E2E limitation (reported, not hidden):** the mobile project ran 11 tests successfully, then `2. Keyboard movement › all four directions work` hit its 60 s per-test timeout, after which the remaining 27 tests did not run (`globalTimeout` 300 s). The same test **passes in isolation in 2.7 s** (`npx playwright test --project=chromium-mobile -g "all four directions work"` → 1 passed). Its page snapshot at timeout shows a fully rendered, connected office, so this is suite-duration/flakiness in that project, not a product regression; the same spec file passes fully in the desktop project. It was not "fixed" by weakening the test.

---

## 7. Remaining limitations and manual checks

1. **Real audio is unverified.** Run §3.5 with two real microphones. Until then only signaling, cleanup and the gain curve are proven.
2. **No automated real-media test.** Chrome's fake device is silent; a custom WebAudio-injected fake track or a real device in CI is needed to automate audible playback.
3. **Mesh scaling is untested.** The topology is O(n²) peer connections. No load test was run, so nothing here supports "50+ concurrent users"; the code comment still recommends an SFU beyond small rooms.
4. **Mute is client-enforced.** A modified client can keep sending audio while reporting `speaking:false`. Server-side audio control would require an SFU.
5. **Reconnect does not resume in-progress media.** Peer connections are re-established after rejoin; brief audio loss on reconnect is expected.
6. **No authentication / room ACL.** See §5.3. Treat this build as a closed prototype.
7. **Offer glare is not resolved.** Simultaneous offers from both sides can drop a peer connection (logged, retried when the roster or mic state changes). Perfect-negotiation / polite-peer logic is the fix, out of scope for this phase.
8. **Gain updates depend on a measured floor.** Before `ResizeObserver` reports a non-zero floor, no gain updates are applied (remote audio stays silent). In practice the floor is measured on first layout.
9. **Mobile Playwright project is flaky in this environment** (§6). Re-run with a longer `globalTimeout`/per-test timeout, or run specs individually, when it matters.
10. **Health endpoint** exposes service/port/Mongo state without auth. Remove or protect it for production.

---

## 8. Reproduction quick reference

```bash
# everything, no external services
cd proxispeak/server && npx vitest run
cd proxispeak && npx vitest run --pool=forks && npm run build

# live database
docker run -d --name proxispeak-mongo-test -p 27018:27017 mongo:7
cd proxispeak/server && MONGODB_TEST_URI=mongodb://127.0.0.1:27018 npx vitest run db.live.test.js
docker rm -f proxispeak-mongo-test

# end-to-end (two terminals)
cd proxispeak/server && PORT=4000 node server.js
cd proxispeak && npx vite preview --port 4173 --host 127.0.0.1
cd proxispeak && npx playwright test --project=chromium-desktop
```
