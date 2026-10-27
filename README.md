# ProxiSpeak — geospatial proximity audio office

A working virtual office: create an account, walk a real Three.js floor, and talk to
the people you are standing near. Presence, collisions and audio distance are all
computed from the same coordinates, server-side identity comes from a signed
session, and the microphone only turns on when you ask it to.

**Status:** runs and is verified locally (unit, integration and browser tests).
It is **not deployed**, no TURN relay is verified in this environment, and
password reset is intentionally not implemented. See [Limitations](#limitations).

---

## What is actually implemented

- **Accounts** — signup, login, logout, current-user, profile updates. Passwords
  are scrypt-hashed; emails are normalized and unique.
- **Sessions** — HMAC-signed, expiring, HttpOnly cookie sessions plus short-lived
  room tokens for Socket.IO. No account token is readable by page JavaScript.
- **Routes** — `/`, `/signup`, `/login`, `/office` (protected), `/settings`
  (protected), and a 404 page. Unauthenticated visitors are sent to `/login` with
  their intended destination preserved.
- **3D office** — React Three Fiber / Three.js scene with a lit floor, walls,
  five zones, desks, chairs, monitors, a meeting table, sofas, plants, a water
  cooler, avatars with name labels, orbit camera and shadows.
- **Movement** — WASD / arrow keys and click-to-walk, delta-time based, with the
  shared circle-vs-rectangle collision model (slides along furniture, cannot leave
  the floor or pass through solids).
- **Presence** — Socket.IO rooms, join/leave, position and speaking broadcasts,
  server-authoritative identity derived from the signed room token.
- **WebRTC audio** — real peer connections, per-peer Web Audio gain driven by
  avatar distance, mute/unmute, cleanup on leave, `GET /api/ice` credential
  delivery (STUN by default, optional TURN).
- **Fallback** — if WebGL is unavailable the accessible 2D floor renders instead;
  presence, movement and proximity audio keep working. `?renderer=2d` forces it.

---

## Quick start (Windows PowerShell)

Two terminals. Node.js 20+ (developed on Node 24) is required.

```powershell
# Terminal A — backend (port 4000)
cd proxispeak\server
npm install
$env:SESSION_SECRET = "dev-only-secret-at-least-32-characters-long"
npm run dev
```

```powershell
# Terminal B — frontend (port 5173)
cd proxispeak
npm install
npm run dev
```

Open <http://localhost:5173>, choose **Get started**, register, and you land in the
office.

- The backend proxies nothing; Vite proxies `/api` to `http://localhost:4000`
  (see `vite.config.js`).
- Without `MONGODB_URI`, accounts are stored in an atomic JSON file at
  `server/.data/users.json`. That is a real persistent store for local/single
  instance use. Production requires MongoDB (see below).
- If `SESSION_SECRET` is omitted in development the server uses a clearly labelled
  development fallback and prints a warning. Never deploy it.

### Optional MongoDB

```powershell
docker compose up -d mongo
cd proxispeak\server
$env:MONGODB_URI = "mongodb://127.0.0.1:27018"
$env:SESSION_SECRET = "dev-only-secret-at-least-32-characters-long"
npm run dev
```

The server reports the active account store in `/api/health`
(`auth.accountStore`). If MongoDB is configured but unavailable, account endpoints
return `503` — accounts are never silently written to the file store instead.

### Production build and preview

```powershell
cd proxispeak
npm run build
npm run preview        # http://localhost:4173, proxies /api to :4000
```

For a same-origin production deployment, serve `dist/` and the API behind one
origin and set `CLIENT_ORIGIN` to that origin. See `docs/PHASE4_DEPLOYMENT.md`
(its account notes are superseded by this README) and
`docs/AUTH_AND_3D.md`.

---

## Routes

| Route | Access | Purpose |
| --- | --- | --- |
| `/` | public | Landing page, product explanation, CTAs |
| `/signup` | anonymous only | Account creation |
| `/login` | anonymous only | Sign in (redirects to the intended page) |
| `/office` | authenticated | 3D virtual office |
| `/settings` | authenticated | Display name, default room, sign out |
| `*` | public | Not-found page |

---

## Authentication and sessions

1. **Signup/login** (`POST /api/auth/signup`, `POST /api/auth/login`) validate the
   input, hash/verify the password with scrypt (`N=16384, r=8, p=1`, per-account
   salt) and set `ps_account` — a signed, expiring account session in an
   `HttpOnly; SameSite=Lax; Path=/` cookie (`Secure` in production over HTTPS).
2. **`GET /api/auth/me`** resolves the account from the cookie and re-reads the
   account record; it is what the app uses to know who is signed in.
3. **`POST /api/auth/session`** requires that cookie and returns a shorter-lived,
   room-scoped HMAC token. The subject and display name are taken from the stored
   account, never from the request body.
4. **Socket.IO** verifies that room token in the handshake and again when it
   expires. Every handler (`office:join`, movement, speaking, WebRTC signaling)
   requires the socket to be in the room its token names.
5. **Logout** revokes the session id and the whole subject, clears the cookie and
   disconnects that account's live sockets. `/api/ice` re-checks revocation.

Signup/login are rate limited per IP (login additionally per email). State-changing
requests are checked against the `CLIENT_ORIGIN` allowlist; combined with
`SameSite=Lax`, that is the CSRF boundary for this design.

### Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/auth/signup` | — | 201 + cookie; 409 `EMAIL_TAKEN` |
| `POST` | `/api/auth/login` | — | 200 + cookie; generic 401 `INVALID_CREDENTIALS` |
| `POST` | `/api/auth/logout` | cookie | revokes session + subject, clears cookie |
| `GET` | `/api/auth/me` | cookie | current account (never the password hash) |
| `PATCH` | `/api/auth/me` | cookie | display name, `preferences.defaultRoom` |
| `POST` | `/api/auth/session` | cookie | room-scoped Socket.IO token |
| `GET` | `/api/ice` | room token | STUN/TURN config for this session |
| `GET` | `/api/health` | — | service + database status |

---

## 3D office

- Stack: `three`, `@react-three/fiber`, `@react-three/drei`
  (three 0.186, R3F 9.8, drei 10.7, React 19). The scene is lazy-loaded, so the
  landing/login pages never download the 3D bundle.
- The world is a scaled projection of the existing floor percentages:
  `100 units × 60 units`, with **1 world unit = 9 floor pixels**. This keeps the
  100 px earshot radius, the collision rectangles and the visible scene in one
  coordinate system.
- Controls: **WASD / arrow keys**, **click the floor to walk**, **drag to orbit**,
  **scroll to zoom**. Movement uses `useFrame` delta time with a clamped maximum
  step; collision resolution is the existing `src/utils/collision.js` model.
- Local position is rendered from a ref and published to React/Socket.IO at
  ~10 Hz, so audio gain and network updates stay current without a 60 fps state
  churn.
- No WebGL (or a lost context) → the accessible 2D floor from
  `src/pages/VirtualOffice.jsx` renders instead, with the same collision and
  proximity logic. Add `?renderer=2d` to force that fallback.
- Internal room dividers are visual zones/thresholds; the solids that block
  movement are furniture plus the outer floor boundary, which is exactly what the
  shared collision model enforces.

---

## Proximity audio

- Microphone access is requested only after pressing **Enable mic**.
- Each peer's remote track is routed through its own Web Audio `GainNode`; the
  gain follows a smooth curve of the pixel distance between avatars with a 100 px
  earshot radius (`src/utils/webrtc.js`).
- People outside earshot end up at zero gain; unrelated rooms never signal each
  other. Local mic audio is never played back locally.
- Muting disables the outgoing track (`track.enabled = false`) and broadcasts
  speaking state.
- **Full-mesh topology**: each participant connects to every other participant in
  the room (O(n²)). It is appropriate for small rooms. An SFU (LiveKit,
  mediasoup) is required before claiming 20–50 participant audio; only signaling
  has been load-tested.

---

## Tests

```powershell
# Frontend unit / DOM tests (jsdom)
cd proxispeak
npm test

# Backend unit + integration (spawns the real server on test ports)
cd proxispeak\server
npm test

# Production build
cd proxispeak
npm run build
```

Browser tests need the built app and the backend running:

```powershell
# Terminal A (fresh process so the in-memory rate limits are not carried over
# from earlier test runs; the suite creates one account per browser context)
cd proxispeak\server
$env:SESSION_SECRET = "browser-test-secret-at-least-32-characters"
$env:CLIENT_ORIGIN = "http://localhost:5173,http://localhost:4173"
$env:AUTH_SIGNUP_RATE_LIMIT = "1000"
$env:AUTH_LOGIN_IP_RATE_LIMIT = "1000"
npm start

# Terminal B
cd proxispeak
npm run build
npm run preview

# Terminal C
npx playwright test --project=chromium-desktop
npx playwright test --project=chromium-desktop-fake-media
```

Last verified results (2026-10-22, Windows, Node 24):

| Command | Result |
| --- | --- |
| `npx vitest run` (frontend) | 14 files, **186 passed** |
| `npx vitest run` (server) | 11 files, **190 passed**, 9 skipped (Docker/Mongo-gated) |
| `npm run build` | success (3D scene split into its own ~950 kB chunk) |
| Playwright desktop | virtual-office 33 passed / 2 skipped; multi-user 4 passed; **3D spec 2 passed**; account flow 2 passed; landing/404 2 passed |
| Playwright fake media | WebRTC peer lifecycle **2 passed** |

MongoDB-gated suites:

```powershell
docker compose up -d mongo
cd proxispeak\server
$env:MONGODB_TEST_URI = "mongodb://127.0.0.1:27018"
npx vitest run db.live.test.js
```

---

## Configuration

Both example files are complete and contain no secrets:
`server/.env.example` and `.env.example`.

Most important:

| Variable | Where | Meaning |
| --- | --- | --- |
| `SESSION_SECRET` | server | **required in production** (≥32 chars); signs both token layers |
| `MONGODB_URI` | server | account persistence; required in production |
| `ACCOUNT_STORE` | server | `mongodb` or `file` (defaults by `MONGODB_URI`) |
| `USER_STORE_FILE` | server | path of the file-backed store |
| `CLIENT_ORIGIN` | server | exact frontend origin(s), `https` in production |
| `TRUST_PROXY` | server | number of trusted proxy hops (0–3) |
| `SESSION_TTL_SECONDS` | server | room-token lifetime (default 3600) |
| `ACCOUNT_SESSION_TTL_SECONDS` | server | cookie lifetime (default 7 days) |
| `ALLOWED_ROOMS` | server | optional room allowlist |
| `TURN_URLS` / `TURN_SECRET` | server | optional TURN relay with ephemeral credentials |
| `VITE_API_URL` / `VITE_SOCKET_URL` | frontend | only for cross-origin API/socket deployments |

---

## Security notes

- Passwords: scrypt (memory-hard, salted), constant-time comparison, no plaintext
  in logs, responses or the store. Account responses are projected to a public
  shape that omits the hash.
- Login performs a real hash verification even for unknown emails so timing and
  the response body do not reveal whether an account exists.
- Identity is never accepted from a client payload: the socket subject and name
  come from the signed room token; `office:join` ignores client-supplied names.
- Room tokens are bound to one room; positions are validated and clamped; WebRTC
  signaling is rejected across rooms.
- In-memory rate limits and revocation lists are per process. A multi-instance
  deployment must share them (Redis/DB) or revoke at the load balancer.
- No audit log, SSO, 2FA, email verification or password reset. Do not claim
  "enterprise security".

---

## Limitations

- **Not deployed.** No public URL, no TLS termination, no TURN relay verified.
  Machines behind restrictive NATs may fail to connect without TURN.
- **Full-mesh WebRTC** — small rooms only; an SFU is a future phase.
- **File account store** is single-instance; production requires MongoDB.
- **No password reset / email verification** — there is no transactional email
  provider configured. The login page states this rather than faking a flow.
- **No light theme.** The design is dark-only; the stored `theme` preference is
  not exposed because it is not applied.
- Demo colleagues are shown only while offline; they are hidden once you join a
  real room.
- Browser audio was verified with Chromium's fake media device (connection, track
  flow, gain wiring). **Physical two-device audibility was not tested here.**
- The 3D scene targets desktop-class GPUs; mobile renders at reduced DPR but was
  not profiled on a physical phone.

---

## Project layout

```
proxispeak/
├── src/
│   ├── App.jsx                 routes and guards
│   ├── auth/                   AuthContext, RequireAuth / RedirectIfAuthenticated
│   ├── pages/                  Landing, Login, Signup, VirtualOffice, Settings, 404
│   ├── three/                  OfficeScene (R3F), world.js geometry, error boundary
│   ├── components/             Brand, AuthFrame, PasswordInput, OfficePreview
│   ├── utils/                  collision, people, layout, socket, webrtc, auth, validation
│   └── __tests__/              186 unit/DOM tests
├── server/
│   ├── server.js               Express + Socket.IO wiring
│   ├── accounts.js             account routes and cookie sessions
│   ├── auth.js                 token signing/verification/revocation
│   ├── passwords.js            scrypt hashing + validation
│   ├── userStore.js            Mongo and file-backed account stores
│   ├── cookies.js, rateLimit.js
│   ├── webrtc.js, ice.js       signaling + ICE credentials
│   └── *.test.js               190 backend tests
├── tests/browser/              Playwright suites (2D fallback + 3D + WebRTC)
└── docs/                       deployment, security, operations, test matrix
```

`docs/AUTH_AND_3D.md` documents the account/3D implementation in more detail.
