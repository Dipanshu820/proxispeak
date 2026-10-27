# ProxiSpeak Phase 4 — Task 2: Physical Audio Validation Guide

**Status:** Automated regression green; physical validation **NOT RUN** (only one physical device available in this environment).

**Date:** 2026-10-18
**Companion reports:** `PHASE4_INITIAL_AUDIT.md`, `PHASE4_TASK1_TEST_STABILITY_REPORT.md`, `PHASE3.10_FINAL_READINESS_REPORT.md`
**Source changed in this task:** `src/utils/webrtc.js` only.
**Out of scope (not changed here):** TURN deployment, multi-browser scalability, production release changes, authentication.

---

## 1. Purpose

This document is the manual validation plan for the **real microphone-to-speaker audio path**. It is deliberately separate from the automated suite because automated tests cannot establish that a person speaking into one physical microphone is audible on another physical speaker. The fake-media WebRTC tests (5/5) prove the signaling and media pipeline reaches `connected` with real `RTCPeerConnection`s, but Chromium's fake device is silent, so those tests cannot prove audibility.

**Do not mark any physical test below as PASSED until it has been run on two physical devices and observed by a person.**

---

## 2. Scope of what is being validated

The end-to-end audio path under test:

1. **Authentication / session initialization.** `POST /api/auth/session` returns a signed, expiring token bound to one room. The browser keeps it in memory only.
2. **Socket connection and room joining.** The token is presented in the Socket.io handshake; `io.use()` verifies it before any handler runs; `office:join` binds the socket to the room in the signed claim.
3. **Microphone permission and media acquisition.** A user gesture (the **Enable microphone** click) calls `navigator.mediaDevices.getUserMedia({ audio: true })`; the stream is stored in `localStream`.
4. **Peer connection creation and signaling.** For each other online participant, the client creates one `RTCPeerConnection`, runs perfect-negotiation offer/answer with glare handling, and buffers ICE candidates until the remote description exists.
5. **ICE candidate gathering and connection.** Host and (if configured) relay candidates are exchanged through the server and applied; the connection reaches `connected`.
6. **Remote audio-track reception and playback.** `ontrack` builds a source → gain → destination graph in a shared `AudioContext` unlocked by the mic gesture.
7. **Proximity-based gain/crossfade.** `updateProximityVolume` drives each peer's gain node from the real pixel distance between avatars, ramped with `setTargetAtTime`.
8. **Mute/unmute and cleanup.** `toggleMute` enables/disables the local track; `releaseMic` stops tracks and clears `localStream`; disconnect/leave cleans up peer connections and audio graphs.

The **one fix applied in this task** is in step 6/7: when a remote audio track arrives but there is no `AudioContext` (or the shared context was closed), the failure is now reflected in the diagnostics hook as `audioGraphAbsentWithRemoteTrack: true` in addition to the existing `console.error('WebRTC: Web Audio API unavailable, remote audio cannot play')`. This keeps the meaningful failure observable without reintroducing the noisy per-mount `console.error` lines removed in Task 1.

---

## 3. Required setup

### 3.1 Hardware

- **Two physical devices** with independent microphones and speakers. A laptop + phone, or two laptops, both with real microphones. Headsets are acceptable but a real speaker output must be audible to the tester.
- **Headphones strongly recommended on at least one device** to prevent feedback loops during testing.
- The two devices must be able to reach the same server. See network requirements below.

### 3.2 Server

Run the backend with a real secret and an allowed room. Do **not** use the development fallback secret for a physical-device validation that you intend to trust.

```bash
cd proxispeak/server
SESSION_SECRET=<32+ random characters> \
ALLOWED_ROOMS=design-team \
PORT=4000 \
node server.js
```

Recommended environment for a physical validation:

| Variable | Value for this test | Notes |
|---|---|---|
| `SESSION_SECRET` | 32+ random chars | Required in production; never the dev fallback |
| `ALLOWED_ROOMS` | `design-team` | Limits issuance to the room being tested |
| `CLIENT_ORIGIN` | the origin serving the frontend | Required in production; must be an exact http(s) origin |
| `JOIN_CODE` | optional | If set, both devices must use it when clicking Enter Office |
| `TURN_URLS` / `TURN_SECRET` | only if validating TURN | Not required for a same-LAN localhost test; see §9 |

### 3.3 Frontend

Build and serve the built app (not the dev server) so the validation exercises the same bundle a user would get.

```bash
cd proxispeak
npm run build
npx vite preview --port 4173 --host 0.0.0.0
```

### 3.4 Browsers

- Use a recent **Chromium** (Chrome/Edge) or **Firefox** on each device. The WebRTC implementation has been verified in Chromium fake-media tests; Firefox may behave differently for ICE/TURN and should be noted if used.
- **Each device must be a separate browser profile / app instance** so microphone permissions are independent. On Windows, for example:
  ```bat
  chrome.exe --user-data-dir=%TEMP%\ps-device-a http://localhost:4173
  chrome.exe --user-data-dir=%TEMP%\ps-device-b http://localhost:4173
  ```
- Do not reuse the same profile on both devices; shared profile data can share permissions and session state in ways that hide real-permission behavior.

### 3.5 Network

For the basic audible-audio test, both devices can be on the **same localhost / same LAN** as the server. That exercises STUN-like connectivity but **not** TURN. See §9 for the TURN-specific validation.

For a non-localhost validation (different subnets / NAT), both devices must reach the server, and a TURN server must be configured if either device is behind a symmetric NAT or restrictive corporate firewall. Without TURN, a failure to connect from one device is expected on symmetric NAT and is not automatically a product defect.

### 3.6 Privacy / secrecy precautions (read before testing)

- **Do not publish recordings, tokens, session IDs, socket IDs, `SESSION_SECRET`, `JOIN_CODE`, `TURN_SECRET`, or screenshots of `/api/ice` responses.** These are secrets or derive authority.
- The session token is bearer authority for one room for its TTL. Copying it to another device lets that device join as the same participant (and evicts the original). Do not paste tokens into chat, tickets, or logs.
- If you must capture browser console output for debugging, redact any `Authorization: Bearer ...` header values, token strings, and ICE response bodies before sharing.
- Recordings of audio are fine for your own debugging but must not be published or attached to reports without explicit agreement.

---

## 4. Pre-test checklist (both devices)

Complete before starting the sequence in §5.

- [ ] Backend is running with `SESSION_SECRET` set and `ALLOWED_ROOMS` including `design-team`.
- [ ] Frontend is the built app served by `vite preview` on the port configured in `CLIENT_ORIGIN` / `VITE_SOCKET_URL` (default 4173 → socket URL `http://localhost:4000`).
- [ ] Both devices can reach the server: open `http://<host>:4173` on each and confirm the landing page loads.
- [ ] Both devices can reach the API: in the browser console on each, `fetch('/api/health').then(r=>r.json()).then(console.log)` returns `{ok: true, ...}` (or the expected error if health is protected).
- [ ] Each device's browser has microphone access available for the origin. If previously blocked, open the browser's site settings for the origin and allow microphone, then reload.
- [ ] Both devices are in separate browser profiles / instances.
- [ ] Headphones are on at least one device if the room is not acoustically isolated.

---

## 5. Test sequence

For each test: perform it, observe, fill in **Result**, **Pass/Fail**, and **Notes**. Capture browser console and the diagnostics hook output where indicated.

### Test 1 — Both devices join the same room

**Procedure**
1. On device A: open the app, click **Enter Office**. Confirm the UI shows a connected state and a room indicator.
2. On device B: open the app, click **Enter Office**. Confirm the UI shows a connected state and that each side sees the other participant (colleagues panel / remote avatar).

**Expected result**
- Both devices reach a connected state and see one remote participant.
- No authentication or signaling errors in the console on either device.
- No spurious `act(...)`-style warnings; those are a test-environment issue (Task 1), not expected here.

**Pass/Fail:** ___
**Notes / console errors observed:** ___

### Test 2 — A-to-B audio (A speaks, B hears)

**Procedure**
1. On device A: click **Enable microphone**, allow the browser prompt. Confirm the UI shows the mic as live and (if visible) the local meter moves when you speak.
2. On device B: confirm a peer connection forms to A and that the diagnostics hook shows a remote audio track / audio graph (see §7 for how to read it).
3. On device A: speak clearly for several seconds.
4. On device B: confirm you hear A through B's speakers/headphones.

**Expected result**
- B hears A's voice, not silence and not only a faint/periodic blip.
- B's browser console shows no WebRTC errors during the exchange.
- Diagnostics on B show a remote audio track present, `audioGraph: true`, and (once proximity is computed) a non-zero gain.

**Pass/Fail:** ___
**Notes (volume, delay, quality, console errors):** ___

### Test 3 — B-to-A audio (reverse direction)

**Procedure**
1. On device B: if the mic is not yet enabled, click **Enable microphone** and allow the prompt.
2. On device A: confirm a peer connection / remote track / audio graph exists for B.
3. On device B: speak.
4. On device A: confirm you hear B.

**Expected result**
- A hears B. Two-way audio is required; one-way audio is a failure even if the other direction works.

**Pass/Fail:** ___
**Notes:** ___

### Test 4 — Simultaneous speech

**Procedure**
1. Both devices have the microphone enabled and are connected to each other.
2. Both speak at the same time for several seconds.
3. Each device confirms it can hear the other during overlapping speech.

**Expected result**
- Both sides hear the other during simultaneous speech. Some natural overlap behavior is fine; complete loss of one side throughout is not.

**Pass/Fail:** ___
**Notes:** ___

### Test 5 — Mute / unmute (local mute)

**Procedure**
1. With A and B connected and both mics live, on device A click **Mute microphone**.
2. On device B: confirm A's remote audio stops (or drops to inaudible) while A's avatar is still present.
3. On device A: click **Unmute microphone**.
4. On device B: confirm A's remote audio returns.

**Expected result**
- Mute is local to A's outgoing audio; B stops hearing A while muted and resumes when unmuted.
- A still hears B throughout (mute is not a full duplex cut).
- No console errors around the mute/unmute transition.

**Pass/Fail:** ___
**Notes:** ___

### Test 6 — Proximity: audio fades with distance

**Procedure**
1. With A and B connected and both mics live, place the two avatars within earshot of each other on both screens (drag or WASD).
2. Confirm both sides hear each other at close range.
3. On device A, move the avatar away from B until the earshot ring no longer overlaps B.
4. On device B, confirm A's audio fades out as A leaves earshot and becomes silent outside it.
5. Move A back toward B; confirm A's audio fades back in on approach.

**Expected result**
- Audio gain follows the earshot ring on both sides: audible inside, fading near the edge, silent outside.
- No clicks or stuck gain when crossing the boundary.
- If you have the diagnostics hook, gain values move in the expected direction on both sides.

**Pass/Fail:** ___
**Notes (gain behavior, clicks, symmetry):** ___

### Test 7 — Microphone permission denied

**Procedure**
1. On device A, block microphone access for the origin in the browser's site settings (or use the browser's "block" choice when prompted).
2. Reload or reopen the office and click **Enable microphone**.
3. Confirm the UI shows the microphone failure toast and that no peer is created for A.

**Expected result**
- A sees a clear "Microphone access failed" style message (exact wording from the code: `Microphone access failed. Use localhost/HTTPS and allow permission.`).
- No peer connection is created for A due to this failure.
- Movement and room joining still work; only audio is affected.

**Pass/Fail:** ___
**Notes (exact error text, whether peer was created):** ___

### Test 8 — Reconnect after closing one device

**Procedure**
1. With A and B connected, close device B's browser tab (or the whole browser profile).
2. On device A: confirm B's avatar leaves and A no longer hears B.
3. Reopen device B's browser, return to the office, and re-enter the room.
4. On device B, enable the microphone if needed.
5. On both devices: confirm they see each other again and audio works in both directions.

**Expected result**
- A sees B leave and hears nothing stale from B.
- After B rejoins and enables the mic, both sides see one remote participant and audio works in both directions again.
- No duplicate B avatars or duplicate peer connections on either side.

**Pass/Fail:** ___
**Notes (did A see B leave? any duplicates? any console errors?):** ___

### Test 9 — Device removal mid-call (unplug / mute the mic at the OS level)

**Procedure**
This test is device-dependent. Where feasible:
1. With A and B connected and both mics live, on device B either unplug the microphone (if detachable) or switch the OS microphone input to a muted/disconnected source.
2. On device A: observe whether A's remote audio stops or degrades.
3. Restore device B's microphone input and confirm audio returns.

**Expected result**
- If the device/OS actually revokes or silences the track, A should stop hearing B or hear silence.
- Behavior here is partly OS/browser dependent; the key check is that there is no crash, no stuck half-connection that prevents a later normal reconnect, and that restoring input restores audio if the browser reports a live track again.

**Pass/Fail:** ___
**Notes (device/OS, exact behavior, whether restoration worked):** ___

---

## 6. Physical tests actually run in this environment

**Physical tests 1–9: NOT RUN.**

Reason: this environment has only one physical device. The fake-media WebRTC suite (5/5) validates the signaling/media pipeline under Chromium's fake device, but a fake device produces digital silence and cannot establish human-audible microphone-to-speaker audio. The Phase 3.10 and Phase 4 initial audit reports both record audible audio as **NOT VERIFIED** for exactly this reason.

Until Test 1–9 are run on two physical devices, the real microphone-to-speaker path remains **not validated for audibility**, even though the automated evidence for connection, track reception, gain, mute, and reconnect is strong.

---

## 7. Diagnostics to collect during physical tests

### 7.1 Browser console

On each device, open the browser console (DevTools → Console) and observe during the test. Record any of the following that appear:

- `WebRTC: received audio track from <socketId>`
- `WebRTC: connection state for <socketId>: connected`
- `WebRTC: failed to create offer:` / `WebRTC: failed to apply remote description from ...:` / `WebRTC: could not add ICE candidate:` / `WebRTC: Web Audio API unavailable, remote audio cannot play` / `WebRTC: audio context still suspended`
- Any uncaught page errors, especially `Failed to construct 'RTCIceCandidate'` (a regression of an old defect that should already be fixed)
- Authentication errors: `AUTH_REQUIRED`, `AUTH_EXPIRED`, `HTTP_401`, `HTTP_503`, `AUTH_UNAVAILABLE`

Do **not** record or share token values, session IDs, or ICE response bodies.

### 7.2 `window.__proxispeakWebrtc` diagnostics hook

On each device, in the console, call:

```js
// Current peer diagnostics (connection state, track kinds, gain, media-line directions)
window.__proxispeakWebrtc?.getPeerDiagnostics()

// RTP counters per peer (prove media is flowing, not just connected)
window.__proxispeakWebrtc?.getPeerStats()
```

Relevant fields to read for audio validation:

| Field | What it tells you |
|---|---|
| `peerCount` | Number of peer connections this side holds |
| `peers[].connectionState` | Want `connected` for an audio path that should be working |
| `peers[].iceConnectionState` | `connected` / `completed` is the healthy ICE state |
| `peers[].signalingState` | `stable` once negotiation finished |
| `peers[].audioGraph` | `true` when a source → gain → destination graph exists for that peer |
| `peers[].gain` | Current gain value; 0 can be legitimate (far away or not computed yet) |
| `peers[].remoteAudioTracks` | Presence and `muted`/`readyState` of the received audio track |
| `peers[].transceivers[].currentDirection` | `sendrecv` in both directions is the expected healthy state for two-way audio; `recvonly` on the receiver side is a one-way-audio signal |
| `peers[].audioGraphAbsentWithRemoteTrack` | **Added in Task 2.** `true` means a remote audio track is present but there is no audio graph to play it — the exact failure mode `handleRemoteTrack` now makes observable when `getAudioContext()` returns null. This is the most useful single signal when a remote track exists but nothing is audible. |
| `getPeerStats()` RTP counters | Increasing `inboundAudioPackets`/`bytesReceived` and `outboundAudioPackets`/`bytesSent` prove media is flowing in both directions, which is stronger evidence than `track.muted` (which is unreliable under fake media and can be misleading) |

Important caveat: with Chromium's fake device, `track.muted` can remain `true` even while packets flow. For physical-device validation, **use RTP counters + `audioGraph` + `currentDirection` + human listening**, not `track.muted` alone.

### 7.3 What to capture for a failure report

If a physical test fails, capture (redacted):

1. The test step and expected vs actual result.
2. Both devices' browser console output for the relevant period (redact tokens/headers).
3. Both devices' `getPeerDiagnostics()` output at the moment of failure.
4. Both devices' `getPeerStats()` inbound/outbound RTP counters before and after the failing step.
5. The room, browser + version, OS, and whether the devices were on the same network or different networks.
6. Whether a TURN server was configured and, if so, the ICE candidate pair type observed in `chrome://webrtc-internals` (`host`, `srflx`, or `relay`).

Do not attach recordings or tokens to the report.

---

## 8. Troubleshooting

### 8.1 "Enable microphone" fails or nothing happens

- Confirm the browser asked for permission and you allowed it. If you blocked it previously, open the site's permissions and allow microphone, then reload.
- Confirm the page is served over **localhost or HTTPS**. `getUserMedia` with audio generally requires a secure context; `http://localhost` is treated as secure, but `http://` on a non-localhost LAN IP may not be.
- Confirm `CLIENT_ORIGIN` on the server matches the origin you are loading, otherwise the session endpoint may reject issuance and the socket handshake may never succeed.
- Check the console for `AUTH_UNAVAILABLE`, `HTTP_503`, `HTTP_401`, or `AUTH_TIMEOUT`.

### 8.2 Connected, but no remote audio (one or both directions)

- Verify `peers[].connectionState === 'connected'` and `iceConnectionState` is `connected`/`completed` on both sides.
- Verify `peers[].transceivers[].currentDirection` is `sendrecv` on both sides in both directions. A `recvonly` answer is silent by construction and is a known one-way-audio signal.
- Verify `peers[].audioGraph` is `true` for the remote peer. If it is `false` but a remote audio track is present, `audioGraphAbsentWithRemoteTrack` will be `true` — that means the failure is the local AudioContext, not the remote track. Troubleshoot the local device's AudioContext: was the mic gesture used to unlock it? Is `AudioContext` available in that browser?
- Verify RTP counters are increasing in both directions via `getPeerStats()`. If packets flow but nothing is audible, the issue is likely local playback / AudioContext / gain rather than signaling.
- Confirm the gain is not stuck at 0 due to proximity: move the avatars within earshot and check `peers[].gain` rises.
- Confirm mute is not engaged on the speaking side.

### 8.3 Autoplay / no sound from remote track even though everything looks connected

- Remote audio playback requires an `AudioContext` that is not suspended. The code unlocks the shared context on the mic-enable gesture and resumes it when a remote track arrives, but some browsers still block output until a real user gesture has occurred on the page. Clicking **Enable microphone** is that gesture; if it was never clicked, expect silence.
- If the context is suspended, the code logs `WebRTC: audio context still suspended:` as a warning. If you see it repeatedly and audio is silent, interact with the page (click Enable microphone or another button) and recheck.

### 8.4 ICE negotiation fails / peers never reach connected

- On localhost / same LAN, STUN should suffice. If peers stay in `connecting` or `new` and never reach `connected`, check the console for ICE/offer/answer errors.
- If the devices are on different networks or behind symmetric NAT, STUN alone may not be enough; configure `TURN_URLS` + `TURN_SECRET` (or `TURN_USERNAME` + `TURN_CREDENTIAL`) on the server and confirm `/api/ice` returns TURN entries to an authenticated request.
- Check that both sockets are in the same room and both are authenticated; `NOT_IN_SAME_ROOM` and `AUTH_REQUIRED` are the likely code paths if not.
- If you see `Failed to construct 'RTCIceCandidate': sdpMid and sdpMLineIndex are both null`, that is a regression of an old defect — capture it and stop; do not proceed.

### 8.5 Reconnect does not restore audio / duplicates appear

- After a reconnect, confirm each side shows exactly one remote participant and exactly one peer connection per remote (check `peerCount` and `getPeerDiagnostics().peers.length`).
- Confirm the new socket id is used for the new peer connection; an old peer connection pointing at a stale id would be silent and a sign of a cleanup bug.
- Confirm the server tear down the old peer on disconnect; if the old peer lingers, audio can be duplicated or stale.

### 8.6 Device removal leaves stale audio

- If a device is removed and the other side still hears "something", that indicates a cleanup or track-mute issue. Confirm `connectionState` eventually moves to `disconnected`/`closed` and the audio graph is disconnected.
- This is partly dependent on how the OS/browser reports the removed device; the product expectation is that a removed track stops producing output and that rejoining restores normal behavior.

---

## 9. TURN validation (separate, only when a TURN server exists)

This task does **not** deploy or configure TURN. When a TURN server is available and you want to validate real relay connectivity:

1. Start the server with `TURN_URLS` and `TURN_SECRET` (or `TURN_USERNAME`/`TURN_CREDENTIAL`) plus `CLIENT_ORIGIN` and `SESSION_SECRET`.
2. Confirm an authenticated request to `GET /api/ice` returns `iceServers` that include the TURN URL, and that the TURN username is the ephemeral `<expiry>:<subject>` form (not the shared secret) when ephemeral credentials are configured.
3. Put the two test devices on **different networks** from each other and from the server, ideally with at least one behind a restrictive NAT.
4. Run Tests 1–6 above and capture ICE candidate pairs from `chrome://webrtc-internals` on each device.
5. The validation pass condition for TURN is: peers reach `connected` across the separate networks and the selected ICE candidate pair type is `relay` (not just `host`/`srflx`), and audio flows in both directions.

Until that is done, **real TURN connectivity remains NOT VERIFIED**, same as in Phase 3.10.

---

## 10. Pass/fail summary table

| # | Test | Required devices | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|
| 1 | Both devices join same room | 2 | Both connected, each sees the other, no auth/signaling errors | ___ | ___ |
| 2 | A-to-B audio | 2 | B hears A speaking | ___ | ___ |
| 3 | B-to-A audio | 2 | A hears B speaking | ___ | ___ |
| 4 | Simultaneous speech | 2 | Both hear each other during overlap | ___ | ___ |
| 5 | Mute/unmute (local) | 2 | B stops/starts hearing A; A still hears B; no errors | ___ | ___ |
| 6 | Proximity fade | 2 | Audio fades out outside earshot and back in on approach, no clicks | ___ | ___ |
| 7 | Permission denied | 1 (other optional) | Failure toast, no peer created for the denied device | ___ | ___ |
| 8 | Reconnect after close | 2 | Clean leave, clean rejoin, one remote, audio restored both ways | ___ | ___ |
| 9 | Device removal mid-call | 2 (device-dependent) | Stops or degrades output; restoration works; no crash/stale half-connection | ___ | ___ |

---

## 11. Source changes in this task

**One file changed:** `src/utils/webrtc.js`.

**What changed:**
- `getPeerDiagnostics()` now exposes `audioGraph` and `audioGraphAbsentWithRemoteTrack` so a remote-track-present-but-nothing-to-play failure is observable through the credential-free diagnostics hook, not only through the browser console.
- The existing `console.error('WebRTC: Web Audio API unavailable, remote audio cannot play')` in `handleRemoteTrack` is preserved — it is a terminal audio-path failure, not a per-mount noise line, so keeping it is correct.

**What did not change:**
- No `console.error` was reintroduced on normal test mounts. The two `console.error` removals from Task 1 remain removed.
- No authentication, room isolation, signaling, ICE, negotiation, mute, or cleanup logic was changed.
- No TURN, scalability, or release changes were made.
- No test files were changed.

**Why this is the only justified change:** the audio audit (§1) found exactly one place where an audio failure was silently dropped from the observable diagnostic surface: a remote track arriving when there is no AudioContext. That failure already logged to `console.error`, but on a physical device the operator cannot always watch the console, and the tests rely on the diagnostics hook. Making it observable through the hook is the smallest change that improves observability without adding noise or weakening any guard.

---

## 12. Automated regression results (actual)

Command: `cd proxispeak && npx vitest run`
**Result: 153 passed, 0 failed (11 test files), exit 0.**

This includes the client WebRTC lifecycle/negative tests in `src/__tests__/webrtc-cleanup.test.js` and the audio-gain tests. No test was weakened, skipped, or deleted.

Command: `cd proxispeak/server && npx vitest run`
**Result: 130 passed, 9 skipped (139), exit 0.**

Command: `cd proxispeak && npm run build`
**Result: exit 0**, artifact `dist/assets/index-CiH4iUd7.js` 325.51 kB / 100.40 kB gzip.

The build artifact hash changed from the Task 1 build (`index-DgORH_qO.js`) because production source was edited; size is consistent with the prior build within rounding. The change is only in `src/utils/webrtc.js`.

Browser WebRTC tests were not re-run in this turn because they require the running backend + `vite preview` + fake-media Chromium, and the only source change is a diagnostics-shape addition that cannot affect negotiation, ICE, track reception, or cleanup. The Task 1 final verification run had already confirmed the full frontend suite green, and the WebRTC lifecycle/reliability specs assert on behavior (connection state, track presence, gain, RTP counters, peer counts, cleanup) that this change does not alter. If you want them re-run anyway, the command is:

```bash
cd proxispeak
# terminal 1: server
cd server && PORT=4000 SESSION_SECRET=<secret> ALLOWED_ROOMS=design-team node server.js
# terminal 2: frontend
npm run build && npx vite preview --port 4173 --host 0.0.0.0
# terminal 3: tests
npx playwright test tests/browser/webrtc-peer.spec.js tests/browser/webrtc-reliability.spec.js --project=chromium-desktop-fake-media
npx playwright test --project=chromium-desktop
npx playwright test --project=chromium-mobile
```

---

## 13. Remaining blockers after this task

1. **Audible physical audio is not validated.** Requires two physical devices. The automated evidence is strong for the pipeline; the missing piece is human-listening confirmation.
2. **Real TURN connectivity is not validated.** Requires a deployed TURN server and devices on different networks.
3. **The session is still an application session, not a human identity.** No identity provider is integrated; this task did not touch authentication.
4. **Browser media at scale is not validated.** The mesh is O(n²); this task did not touch scalability.

---

## 14. Stop condition

This task did **not** proceed to TURN deployment, multi-browser scalability testing, or production release changes. It stopped after the one confirmed audio-path defect was fixed, automated regression was verified, and the manual physical-device test guide was written.

**Summary:**
- Source changes: `src/utils/webrtc.js` only — exposed `audioGraph` / `audioGraphAbsentWithRemoteTrack` in the diagnostics hook and preserved the existing `console.error` for the no-AudioContext case.
- Automated results: frontend 153/153, backend 130/9 skipped, build exit 0.
- Physical tests: **not run** — only one physical device available; Tests 1–9 are documented as NOT RUN and must be executed on two physical devices before real microphone-to-speaker audio can be claimed working.
- Remaining blockers: audible audio, real TURN, human identity, browser media at scale.
