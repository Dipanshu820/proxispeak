# ProxiSpeak Phase 3.9 — WebRTC End-to-End Verification and Security Closure

**Date:** October 18, 2026
**Overall status:** `PARTIALLY VERIFIED`

Why not `VERIFIED`: the two-browser lifecycle, proximity gain, cleanup, reconnection, database and regression results below are measured and passing. Two things are still not proven: **audible microphone-to-microphone audio** (this environment has no microphone; Chromium's fake device is silent) and **authenticated identity / private-room authorization** (deliberately not faked — see §6). Nothing here claims 50+ concurrent users; no load test was run.

---

## 1. Files changed and why

| File | Change | Reason |
|---|---|---|
| `src/utils/webrtc.js` | Rewritten negotiation core: perfect-negotiation collision handling, single peer connection per remote, ICE candidate buffering before the remote description, mic tracks attached to already-open connections, `replaceTrack` across mic cycles, idempotent `init()`, disconnect-safe cleanup, read-only `getPeerDiagnostics()`. | The previous code could not sustain a real connection: answers were rejected by the server (fixed in 3.8), the initiator never received local audio, colliding offers overwrote each other, and candidates arriving early were dropped. |
| `src/pages/VirtualOffice.jsx` | Added the diagnostics hook; replaced the two broken position broadcasts with one throttled, state-driven effect; cleans up peer connections when the socket disconnects; removed the unused `acceptPeerConnection` import. | See defects D1 and D4. |
| `src/__tests__/webrtc-cleanup.test.js` | Fake `RTCPeerConnection` now models signalling states; 19 tests cover creation, glare (polite/impolite), ICE buffering, late answers, cleanup, mic cycles, per-peer independence, diagnostics. | Focused regression coverage for the new negotiation logic. |
| `tests/browser/webrtc-peer.spec.js` | **New** two-context browser spec: connect → join → enable mic on both → offer/answer/ICE → both `connected` → remote audio track present → gain follows real pixel distance → mute → disconnect cleanup → reconnect → unmount → remount. Skips outside the fake-media project. | The only way to prove the handshake actually completes in browsers. |
| `server/webrtc.js` | Per-socket signaling rate limit (120 events / 10 s, bucket released on disconnect). | A single client could flood offers/answers/candidates. |
| `server/config.js` | `parseAllowedRooms()` / `isRoomAllowed()`. | Optional room allowlist (deployment control, not authentication). |
| `server/server.js` | Enforces `ALLOWED_ROOMS` in `office:join` (`ROOM_FORBIDDEN`). | Stops clients inventing room ids when configured. |
| `server/startup.test.js` | +8 tests: allowlist parsing/matching and a real-server test that a forbidden room is rejected while a listed room joins. | Prove the enforcement on the actual entrypoint, not a mock. |
| `server/webrtc.test.js` | +2 tests: signaling flood is rate-limited; a peer disconnecting mid-negotiation does not wedge the survivor. | Regression for the new limit and for Priority D's disconnect-during-negotiation case. |
| `PHASE3.9_VERIFICATION_REPORT.md` | This report. | Deliverable. |

No passing test was weakened, skipped or deleted to make anything green. One test from Phase 3.8 (the `webrtc:accept` contract test) remains replaced because it asserted a contract that made every real handshake fail; that change was explained and verified in Phase 3.8 and is re-verified here by the browser test.

---

## 2. Defects found, root cause, fix

### D1 — Position updates were never sent (proximity gain and remote movement frozen)
**Symptom:** with two browsers connected, moving A changed A's own view but B's remote avatar never moved, so B's gain never changed.
**Root cause (reproduced):** the animation loop called `socketUpdatePosition(resolved.x, resolved.y)` where `resolved` was declared **inside** the `setPeople` updater, and the call was additionally gated on `isInRoom`, which was captured by an effect that only re-runs when the floor is re-sized — i.e. before `office:joined`, so it stayed `false` for the session. The drag handler had the same out-of-scope `resolved`. Browser evidence before the fix: A's avatar gap grew 12 → 268 px while B's reported gap stayed at exactly 87.2 px and its gain stayed at 0.2156.
**Fix:** one effect that broadcasts `me.x/me.y` whenever they change, throttled to 10 sends/s with a trailing send so the final resting position always goes out (the server allows 20/s). Browser evidence after the fix: `gapA ≈ gapB` at every step and both gains track the distance (0.92 → 0.78 → 0.67 → 0.54 → 0.40 → 0.19 → 0.04 → 0).

### D2 — ICE candidates were malformed in transit
**Symptom:** uncaught page errors `Failed to construct 'RTCIceCandidate': sdpMid and sdpMLineIndex are both null.` (two per page).
**Root cause:** the client emitted the whole `RTCIceCandidate` object as `candidate` and never sent `sdpMid`/`sdpMLineIndex`; the server relayed the missing fields; the receiver constructed `new RTCIceCandidate({ candidate, sdpMid: null, sdpMLineIndex: null })`, which throws.
**Fix:** emit the candidate **string** plus both identity fields; the receiver refuses candidates without either field (warn + drop) instead of throwing inside a socket handler. Verified by the absence of page errors in the browser run and by the ICE-buffering unit test.

### D3 — Local microphone was never attached to peers that already existed
**Symptom:** one side's RTCPeerConnection reached `connected` but its remote receiver track was `muted: true`; the other side heard nothing from it.
**Root cause:** a peer connection is created as soon as presence is known (before the microphone is enabled) and `addTrack` only ran at creation. Enabling the mic later renegotiated nothing and added no track.
**Fix:** `requestMic()` attaches the new audio track to every open connection (`addLocalAudioTracks`) and renegotiates; repeated enable/disable cycles reuse the stopped sender via `replaceTrack` rather than stacking senders. Verified in the browser (both receivers `muted: false`) and by the mic-cycle unit test.

### D4 — Simultaneous offers (glare)
**Symptom:** both participants enable their mic at roughly the same time and each creates an offer. The old `acceptPeerConnection` unconditionally created a **new** `RTCPeerConnection` and overwrote the map entry, so one side's connection was orphaned and audio flowed in one direction only.
**Fix:** perfect negotiation. Roles are derived from the server-assigned socket ids (`localId < remoteId` ⇒ polite), so the two sides always compute opposite roles. On collision the polite peer rolls back its local offer and answers the incoming one; the impolite peer ignores the colliding offer. Duplicate `initiate` calls reuse the existing connection, and `onnegotiationneeded` drives renegotiation. Covered by two unit tests (polite rolls back and answers; impolite ignores) and by the browser test, where each side ends with **exactly one** peer connection.

### D5 — ICE candidates that arrived before the remote description were lost
Candidates are now buffered per peer and flushed after `setRemoteDescription`. Verified by unit test and by the connected state in the browser run.

### D6 — Stale peers after a socket disconnect, duplicate listeners, late answers
Peers are torn down on socket disconnect; `init()` is idempotent; answers received when no local offer is pending are ignored instead of corrupting the connection. Each has a unit test. A peer that disconnects **mid-negotiation** is covered too: the survivor immediately completes a new exchange with a third socket (server test), and the browser spec re-enters the office after unmount and reconnects successfully.

---

## 3. Exact commands and actual results

All commands run from `proxispeak` (Git Bash on Windows, Node v24.18.0). The browser runs used `vite preview` serving `dist` from disk; the served asset hash was checked against `dist/assets/index-*.js`, and the build (`index-eW0aHIOs.js`) was produced after the last client change and before the browser runs.

| # | Command | Result |
|---|---|---|
| 1 | `cd proxispeak/server && npx vitest run` | **70 passed, 7 skipped (77)**, exit 0 — `webrtc.test.js` 26, `startup.test.js` 21, `db.test.js` 9, `server.test.js` 14 (+1 pre-existing skip), `db.live.test.js` 6 skipped (gated) |
| 2 | `cd proxispeak && npx vitest run --pool=forks` | **142 passed (10 files)**, exit 0 — includes 19 lifecycle tests and 6 gain tests |
| 3 | `cd proxispeak && npm run build` | success — `dist/assets/index-eW0aHIOs.js` 321.17 kB (99.00 kB gzip), CSS 27.71 kB |
| 4 | `cd proxispeak && npx playwright test tests/browser/webrtc-peer.spec.js --project=chromium-desktop-fake-media` | **2 passed (1.8 m)**, exit 0 |
| 5 | `cd proxispeak && npx playwright test --project=chromium-desktop` | **37 passed, 4 skipped**, exit 0 (2 skips pre-existing; 2 = the new spec, which skips by design in this project) |
| 6 | `cd proxispeak && npx playwright test --project=chromium-mobile` | **38 passed, 3 skipped**, exit 0 (1.1 m) |
| 7 | `docker run -d --name proxispeak-mongo-test -p 27018:27017 mongo:7` then `MONGODB_TEST_URI=mongodb://127.0.0.1:27018 npx vitest run db.live.test.js` | **6 passed**, exit 0 |
| 8 | Production CORS guard, four separate process launches | all exit **1** (see §6) |

The mobile project completed this run. In Phase 3.8 the same project aborted on a 60 s timeout; that test still passes in isolation and the suite is unchanged, so the earlier result was environmental/suite-duration flakiness, not a product regression — reported, not hidden.

---

## 4. Browser-level WebRTC results (what the two-context spec proves)

Sequence executed against the real backend (`:4000`) and the built frontend (`:4173`):

1. Two independent browser contexts join `design-team`; each sees `Real-time with 1 remote` and receives a distinct server socket id.
2. Both click **Enable microphone**; Chromium's fake device grants permission automatically.
3. Both peer connections reach `connectionState: "connected"` / `iceConnectionState: "connected"` with `signalingState: "stable"`.
4. **Exactly one peer connection per side** (glare resolved, no duplicates).
5. The receiving `RTCPeerConnection` has an audio receiver track, `muted: false`, `readyState: "live"`, and `audioGraph: true` (source → gain → destination exists).
6. Proximity: walking A outside the 100 px earshot drives B's gain below 0.05; walking back raises it, and the measured gain matches `0.1 + 0.9·(1 − d/100)` for the pixel distance B observes (tolerance 0.1).
7. Mute on A sets `micActive: false` while B's gain node is unchanged (mute is a local track state).
8. Closing A's context removes the peer and its audio graph from B (peer count 0).
9. A new session reconnects, negotiates again, and B holds exactly one peer with the new id.
10. Navigating away unmounts the component: the diagnostics hook disappears and the peer is torn down remotely.
11. Re-entering the office on the same page (remount) installs the hook again, negotiates a fresh connection with the remaining peer, and both sides hold exactly one peer.
12. No uncaught page errors and no failed signaling events during the run (asserted; the ICE-candidate page error from D2 is gone).

**Audio level distinction**

| Level | Status |
|---|---|
| Signaling decisions (offer/answer/ICE, glare, authorization) | VERIFIED — unit + two-browser |
| Real RTCPeerConnection reaches `connected` in two browsers | VERIFIED — this run |
| Remote audio track present and unmuted in the receiving pipeline | VERIFIED — this run |
| Gain node follows measured pixel distance | VERIFIED — this run |
| **Human-audible microphone → speaker audio** | **NOT TESTED** — fake device is silent; requires two real microphones (§8) |

---

## 5. Proximity gain and cleanup details

- Distance uses `pctToPixels`/`pixelDistance` on the measured floor, the same coordinate system as the earshot ring and the colleagues panel. `proximityGain` is 1.0 at 0 px, linear to 0.1 just inside 100 px, 0 at/beyond 100 px — unit-tested and matched in the browser.
- Gain is recalculated when either avatar moves or the floor is resized (the effect depends on `people` and `floorSize`); updates are throttled by the position broadcast (10/s) rather than firing every animation frame, and use `setTargetAtTime(…, 0.03)` so changes ramp instead of clicking.
- A peer outside earshot is driven to exactly 0, so a distant peer cannot be left audible.
- Gain updates after cleanup are no-ops (test asserts no throw, no resurrected connection, no diagnostics entry).
- Multiple peers keep independent gain nodes and connections; cleaning one leaves the other open and unanswered offers cannot resurrect a cleaned peer.
- A failed audio path cannot break the floor: with `getUserMedia` forced to reject, the app shows the permission toast, creates no peer, and keyboard movement still works (browser test).

---

## 6. Authentication, room authorization, CORS

**What is enforced server-side (verified):**
- The only identity used on the wire is the server-assigned `socket.id`; clients cannot publish positions, speaking state, offers, answers or candidates as another socket.
- `webrtc:offer`, `webrtc:accept`, `webrtc:initiate`, `webrtc:ice-candidate` require emitter and target in the same room; an answer must correspond to a recorded offer and cannot be self-issued.
- Presence/movement broadcasts are room-scoped; positions are validated, clamped and rate-limited.
- Display names are untrusted text and normalized (control characters stripped, 40-char cap, `Guest` fallback).
- Signaling is rate-limited per socket (120 events / 10 s).
- `ALLOWED_ROOMS` (optional) rejects invented room ids with `ROOM_FORBIDDEN`; verified against the real server process.

**CORS / production startup (re-verified this phase):**

| Configuration | Exit | Message |
|---|---|---|
| `NODE_ENV=production`, no `CLIENT_ORIGIN` | 1 | `FATAL: CLIENT_ORIGIN is not configured for production…` |
| `…CLIENT_ORIGIN=*` | 1 | `FATAL: CLIENT_ORIGIN must not contain a wildcard…` |
| `…CLIENT_ORIGIN=not-a-url` | 1 | `FATAL: CLIENT_ORIGIN is not a valid absolute URL…` |
| `…CLIENT_ORIGIN=http://localhost:5173` | 1 | `FATAL: CLIENT_ORIGIN is not configured for production…` |

Development still starts normally with the default origin (asserted by `startup.test.js`), and a valid production origin starts and logs `listening`.

**What remains unsolved — identity and private rooms.** There is no account, token, invite or password. Any client that can reach the socket endpoint can join any allowed room and choose any display name. `ALLOWED_ROOMS` limits *which* rooms exist, not *who* may enter them, and it must not be presented as authentication.

Minimum required implementation (not attempted here, because it is an architectural decision and a partial version would be worse than none):
1. Issue a signed, short-lived join ticket over HTTPS from an HTTP endpoint or an existing identity provider.
2. Validate it in the Socket.io handshake and bind `socket.data.user` to the verified subject; ignore client-supplied identity when a verified profile exists.
3. Check private-room membership server-side (MongoDB is already wired) inside `office:join`.
4. Keep every guard above; they remain necessary afterwards.
5. Protect or remove `/api/health` in production.

**Recommendation:** keep this build development-only / closed-prototype until steps 1–3 are in place.

---

## 7. MongoDB status

Re-verified this phase against a real `mongo:7` container: connection, index creation (unique email, 2dsphere on `location.geometry`, unique office slug, session indexes), persistence across a client reconnect, unique-email enforcement, virtual-coordinate mapping (0–100 % ↔ virtual lon/lat, never real geography), and a real `$geoWithin` proximity query that returned the near peers and excluded both a far peer and a peer in another office. **6/6 passed.** Graceful degradation when `MONGODB_URI` points at nothing was re-checked in Phase 3.8 and the code path is unchanged (`ok:false`, `mongodb:"error"`, server keeps serving).

---

## 8. Manual Windows testing still required

Audible audio cannot be automated here. Two separate Chrome sessions (separate `--user-data-dir`), backend on `:4000`, `npm run build` + `vite preview` on `:4173`, headphones:

1. Both windows: **Enter Office**, confirm `Real-time with 1 remote`.
2. Both windows: **Enable microphone**, allow the prompt (`chrome://settings/content/microphone` if it was blocked).
3. Speak into A — confirm you hear it in B, and the reverse.
4. Walk the avatars apart and together — confirm the voice fades in/out at the earshot ring and is silent outside it.
5. Mute/unmute A — B stops/starts hearing A while A keeps hearing B.
6. Close A — B sees the avatar leave and hears nothing stale.
7. Reopen A, rejoin, enable mic — audio works again with exactly one A visible.
8. Block the microphone for the origin and click **Enable microphone** — expect the failure toast, no peer, movement still works.

Also worth running once on a real network (not localhost) to exercise STUN/TURN behaviour; see §9.

---

## 9. Remaining security and reliability risks

1. **No authentication / private-room ACL** (§6). Highest priority before any exposure.
2. **STUN only, no TURN.** Peers behind symmetric NAT or restrictive corporate firewalls may fail to connect. The browser test runs on one machine, which cannot detect this.
3. **Mesh topology is O(n²).** No load test was run; nothing here supports a claim of 50+ concurrent users. The code comment still recommends an SFU beyond small rooms.
4. **Mute is client-enforced.** A modified client can transmit while reporting `speaking:false`; true server-side audio control needs an SFU.
5. **Renegotiation races.** Glare between the initial offers is resolved and tested; rapid mic toggling plus simultaneous renegotiation is handled by the same rules but not stress-tested.
6. **Socket-level reconnect.** A new session reconnects correctly (browser test). Recovering the *same* socket after a temporary network drop relies on Socket.io reconnection plus server-side peer teardown; it was not exercised end-to-end because the server's disconnect detection takes ~20 s.
7. **Diagnostics hook** (`window.__proxispeakWebrtc`) exposes connection state, track kinds and gain values — no media, no SDP, no credentials. It is read-only and intended for tests/operators; remove it if a hardened production build is desired.
8. **Mobile suite duration** is close to its global timeout; a slow machine can still abort it (see §3).
9. **No audible verification** (§8).

---

## 10. Reproduction

```bash
# unit + integration tests
cd proxispeak/server && npx vitest run
cd proxispeak && npx vitest run --pool=forks && npm run build

# live database
docker run -d --name proxispeak-mongo-test -p 27018:27017 mongo:7
cd proxispeak/server && MONGODB_TEST_URI=mongodb://127.0.0.1:27018 npx vitest run db.live.test.js
docker rm -f proxispeak-mongo-test

# browser (two terminals for the servers)
cd proxispeak/server && PORT=4000 node server.js
cd proxispeak && npx vite preview --port 4173 --host 127.0.0.1
cd proxispeak && npx playwright test tests/browser/webrtc-peer.spec.js --project=chromium-desktop-fake-media
cd proxispeak && npx playwright test --project=chromium-desktop
cd proxispeak && npx playwright test --project=chromium-mobile
```
