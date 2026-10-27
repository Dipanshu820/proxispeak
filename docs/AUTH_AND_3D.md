# Accounts, sessions and the 3D office

This document describes the implementation added on top of the Phase 4 signaling
work. The older `PHASE4_*` documents remain accurate about sockets, ICE and
deployment guards, but their "no account system" statements are superseded here.

## 1. Layers

```
Browser
  ├─ HttpOnly account cookie  ──►  /api/auth/*          (identity)
  ├─ room token (memory only) ──►  Socket.IO handshake  (office access)
  └─ WebRTC peer connections  ──►  media (DTLS-SRTP)    (voice)
```

Two independent signed layers, both HMAC-SHA256 with `SESSION_SECRET`:

| Layer | Format | Claims | Storage | Lifetime |
| --- | --- | --- | --- | --- |
| Account session | `v2.<b64url claims>.<sig>` | `v:2, typ:"account", sub, name, jti, iat, exp` | `ps_account` cookie, `HttpOnly`, `SameSite=Lax`, `Secure` in production | 7 days (`ACCOUNT_SESSION_TTL_SECONDS`) |
| Room token | `v1.<b64url claims>.<sig>` | `v:1, sub, name, room, jti, iat, exp` | JS memory only (`auth.js` module) | 1 hour (`SESSION_TTL_SECONDS`) |

The versions and claim sets are distinct, so a room token cannot be replayed as an
account session or vice versa (`accounts.test.js` asserts both directions).

The socket subject is the account id. The socket display name is the account's
stored name; `office:join` ignores `payload.user.name`, so a client cannot
impersonate another participant.

### Cookie and CSRF model

- `SameSite=Lax` keeps the cookie off cross-site subrequests.
- Every state-changing `/api` request with an `Origin` header must match
  `CLIENT_ORIGIN` (exact match; loopback origins allowed only outside production).
- CORS is an explicit allowlist with `credentials: true`; no wildcard.
- `Secure` is set whenever production runs over TLS. An explicitly opted-in
  plain-HTTP pilot does not set a cookie the browser would refuse to store.
- No CSRF token is required by this combination; if the cookie policy changes to
  `SameSite=None`, add double-submit tokens.

### Logout and revocation

`POST /api/auth/logout`:

1. verifies the account cookie,
2. adds the session `jti` to the in-memory revocation list,
3. revokes the whole account subject (so any room token already issued stops
   working),
4. disconnects the account's live sockets,
5. clears the cookie (`Max-Age=0`).

The revocation list is per process. Multi-instance deployments must share it or
revoke at the edge.

## 2. Account storage

`server/userStore.js` exposes one interface with two real implementations:

- **MongoDB** (`users` collection, unique index on `email`) whenever
  `MONGODB_URI` is set, or `ACCOUNT_STORE=mongodb`.
- **JSON file** (default `server/.data/users.json`, mode `0600`, atomic
  temp-file + rename, serialized writes) otherwise.

There is no silent fallback: a configured-but-unreachable MongoDB produces `503
ACCOUNT_STORE_UNAVAILABLE`, never a second account written to the file. Production
refuses to start on the file store unless
`PROXISPEAK_ALLOW_FILE_ACCOUNT_STORE=true` is set for a known single instance.

Stored record: `id`, normalized `email`, `name`, `passwordHash`, `avatarColor`,
`preferences { theme, defaultRoom, mutedByDefault }`, timestamps, `lastLoginAt`.
The password hash is only returned by the internal `find*` methods and is stripped
by `publicAccount()` before any HTTP response.

## 3. Validation and error codes

Passwords: 10–200 characters, at least one letter and one number (documented in
the UI). Emails: trimmed/lowercased, ≤254 characters, conservative dotted-domain
check. Names: 2–40 characters after control-character stripping.

| HTTP | Codes |
| --- | --- |
| 400 | `NAME_*`, `EMAIL_INVALID`, `EMAIL_TOO_LONG`, `PASSWORD_*`, `PASSWORD_MISMATCH`, `INVALID_PREFERENCES`, `INVALID_ROOM`, `INVALID_THEME`, `NOTHING_TO_UPDATE` |
| 401 | `AUTH_REQUIRED`, `INVALID_CREDENTIALS`, `AUTH_EXPIRED`, `AUTH_REVOKED`, `INVALID_SIGNATURE` |
| 403 | `HTTPS_REQUIRED`, `ORIGIN_FORBIDDEN`, `ROOM_FORBIDDEN`, `INVALID_JOIN_CODE` |
| 409 | `EMAIL_TAKEN` |
| 429 | `RATE_LIMITED` (with `Retry-After`) |
| 503 | `ACCOUNT_STORE_UNAVAILABLE` |

Login returns the same body and status for an unknown email and a wrong password,
and performs a scrypt verification against a dummy hash for unknown emails.

## 4. Socket authorization

| Event | Requirement |
| --- | --- |
| handshake | valid, unexpired, unrevoked room token; subject not revoked |
| `office:join` | token room == requested room, room allowed, one socket per subject |
| `position:update` | in a room, finite numbers, clamped to 0–100, 20/s |
| `speaking:update` | in a room, boolean |
| `office:leave` | in a room |
| `webrtc:*` | both peers in the same room; sender/target consistency checks in `webrtc.js` |
| token expiry | enforced for the socket lifetime, not just the handshake |

## 5. The 3D scene

`src/three/OfficeScene.jsx` renders with React Three Fiber; `src/three/world.js`
holds pure geometry/movement helpers (no Three import) so they are unit-testable.

### Coordinate system

```
world x = (xPercent / 100) * 100 - 50        range −50 … +50
world z = (yPercent / 100) *  60 - 30        range −30 … +30
1 world unit = 9 floor pixels                (900 px × 540 px reference floor)
earshot ring radius = 100 px / 9 ≈ 11.11 world units
```

Every floor percentage therefore maps to exactly one world position, and the
collision model's pixel math is unchanged. `world.test.js` asserts round-tripping,
furniture projection and the earshot constant.

### Scene contents

- floor slab + grid, perimeter walls (back/sides tall, front curb so the camera is
  not blocked),
- five zone planes with labels generated from `OFFICE_LAYOUT`,
- every solid from `FURNITURE`: desks with legs/monitors/chairs, the meeting table,
  sofas; plants and a water cooler as decoration,
- one directional light with a 1024² shadow map, ambient/hemisphere fill, a cool
  point light,
- avatars: capsule body, head, ring for self, speaking ring, HTML name label,
- `OrbitControls` (damped, pan disabled, polar/distance limits).

### Movement

- `useFrame((state, delta))`, delta clamped to 100 ms, speed 90 px/s, max step 8 px.
- Direction normalized in percentage space; collision resolved with
  `resolveCollision` (axis-separated sliding).
- Click-to-walk snaps the clicked point to the nearest free floor and walks toward
  it with the same solver.
- Local position lives in a ref (no per-frame React state); it is published at
  ~10 Hz, which drives socket broadcasts, the colleague list and audio gain.
- A large programmatic jump (>2.5%) re-seats the avatar (layout restore/reset).

### Performance and failure handling

- Scene bundle is lazy-loaded and split (`OfficeScene-*.js`).
- DPR capped at 1.75, one shadow-casting light, 1024² shadows, shared small
  geometries, no physics engine.
- `isWebGLAvailable()` probes before importing Three; a React error boundary
  catches a failed mount; a lost context event flips back to the 2D floor.
- jsdom never imports Three, which keeps the DOM suites fast.

## 6. Proximity audio

Existing `src/utils/webrtc.js` is unchanged in its contract:

```
remote MediaStreamTrack → MediaStreamAudioSourceNode → GainNode → destination
```

`VirtualOffice` recomputes each connected peer's gain whenever a position changes
using `pctToPixels` + `updateProximityVolume`, with the 100 px earshot and a smooth
falloff. In 3D mode the fixed 900×540 projection is used because it *is* the world
scale; in 2D mode the measured DOM floor is used. Both feed the same function.

## 7. Verification performed

| Check | Result |
| --- | --- |
| `server: npx vitest run` | 190 passed, 9 skipped (Docker-gated), includes 24 new account tests |
| `frontend: npx vitest run` | 186 passed, including 15 world/movement tests, 9 auth-page tests |
| `vite build` | success |
| Playwright `office-3d.spec.js` (Chromium, real WebGL) | 2 passed — canvas context live, avatar moves with `d`, no console errors, 2D override works |
| Playwright `virtual-office.spec.js` (2D fallback) | 33 passed, 2 skipped |
| Playwright `multi-user.spec.js` | 4 passed with two independent accounts |
| Playwright `webrtc-peer.spec.js` (fake media) | 2 passed — peer lifecycle, tracks, gain, cleanup |
| Physical two-device audio | **not performed** |
| TURN relay | **not configured/verified** |
| Public deployment | **none** |

## 8. Production checklist

1. `NODE_ENV=production`, `CLIENT_ORIGIN=https://…`, `SESSION_SECRET` (32+ random
   bytes), `MONGODB_URI`, `TRUST_PROXY` matching the real proxy hop.
2. Serve `dist/` and `/api` from one origin behind TLS.
3. Set up a TURN server if participants are behind restrictive NATs, then verify a
   relay-only run (`ICE_TRANSPORT_POLICY=relay`).
4. Plan for shared rate limiting/revocation if running more than one instance.
5. Add a transactional email provider before offering password reset; do not ship
   a fake reset flow.
