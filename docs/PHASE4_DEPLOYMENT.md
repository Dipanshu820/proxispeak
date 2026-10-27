# ProxiSpeak — Deployment Guide (Phase 4)

> **Update:** production now also requires an account store. Set `MONGODB_URI`
> (required in production) and configure `ACCOUNT_SESSION_TTL_SECONDS` as needed.
> See `docs/AUTH_AND_3D.md` and the project README for the current setup.

This document describes how to deploy the current repository. It documents what
the code actually does; it does not describe a deployment that has been
performed. No production host, credential, or uptime claim exists in this repo.

---

## 1. What gets deployed

| Component | Artifact | Process |
| --- | --- | --- |
| Frontend | `dist/` from `npm run build` | Static files served by the edge/reverse proxy |
| Backend | `server/server.js` | Node.js process — **Node 22.12+ or 24+** (Vitest 5 rejects Node 20 entirely; Vite 8 needs >= 20.19). Verified on Node 24.18.0 |
| Signalling | Socket.IO, same process/port as the API | — |
| Database | MongoDB (optional) | External or sidecar |

The backend speaks **plain HTTP**. TLS is expected to be terminated by a reverse
proxy (nginx, Caddy, an ALB, etc.) in front of the Node process. The application
does not terminate TLS itself.

Because of that, production startup requires the operator to declare the proxy:

```bash
TRUST_PROXY=1            # exactly one TLS-terminating hop
CLIENT_ORIGIN=https://proxispeak.example.com
SESSION_SECRET=<48 random bytes, base64url>
```

With `TRUST_PROXY` unset, `req.secure` is always false, and the token endpoints
(`/api/auth/session`, `/api/auth/revoke`, `/api/ice`) answer `403 HTTPS_REQUIRED`
in production. That is deliberate: the app fails closed rather than issuing
session tokens over plaintext.

### Reverse proxy sketch (nginx)

```nginx
server {
  listen 443 ssl http2;
  server_name proxispeak.example.com;

  # Serve the built frontend
  root /srv/proxispeak/dist;
  location / {
    try_files $uri /index.html;
  }

  # API + WebSocket to the Node process
  location /api/ {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }

  location /socket.io/ {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 600s;
  }
}

server {
  listen 80;
  server_name proxispeak.example.com;
  return 301 https://$host$request_uri;
}
```

Serving the frontend and the API from one origin is the intended topology: the
browser then sends same-origin `/api/...` calls and the session token never needs
CORS. `CLIENT_ORIGIN` must still list that origin, because Socket.IO and the
state-changing-request guard validate it.

---

## 2. Environment variables

The authoritative template is `server/.env.example`; the frontend's build-time
variables are in `.env.example` at the repository root. Summary:

### Required in production

| Variable | Purpose | Failure mode if missing |
| --- | --- | --- |
| `NODE_ENV=production` | Enables the production guards | Runs in development mode (insecure fallbacks allowed) |
| `CLIENT_ORIGIN` | Allowed frontend origin(s), comma-separated, bare `https:` origins | Process exits 1 |
| `SESSION_SECRET` | HMAC key for session tokens, >= 32 chars | Process exits 1 |
| `TRUST_PROXY` | Proxy hop count (`1` for one TLS proxy) | HTTPS enforcement rejects token requests |
| `JOIN_CODE` or `AUTH_ALLOW_ANONYMOUS=true` | How sessions are issued | `/api/auth/session` returns 503 |

> `AUTH_ALLOW_ANONYMOUS=true` in production means anyone who can reach the site
> gets a session. Use it only for a closed, trusted network, or front the app with
> your own issuer.

### Optional

| Variable | Effect |
| --- | --- |
| `ALLOWED_ROOMS` | Comma-separated room allowlist (issuance + join) |
| `SESSION_TTL_SECONDS` | Token lifetime, 60–86400 (default 3600) |
| `HEALTH_TOKEN` | Bearer token required for `GET /api/health` |
| `MONGODB_URI` | Enables persistence/health reporting; absence is not fatal |
| `MONGODB_WATCHDOG_MS` | Health/reconnect interval, >= 1000 (default 5000) |
| `STUN_URLS` | Comma-separated STUN URLs (defaults to Google STUN) |
| `TURN_URLS` / `TURN_SECRET` | TURN relay with ephemeral credentials |
| `TURN_TTL_SECONDS` | Ephemeral TURN credential lifetime |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | Static TURN credentials (not recommended) |
| `ICE_TRANSPORT_POLICY` | `all` (default) or `relay` (requires TURN) |
| `REQUIRE_HTTPS` | Default true in production; `false` is a deliberate downgrade |
| `PROXISPEAK_ALLOW_HTTP_ORIGIN` | Explicit http-pilot opt-in; relaxes origin + HTTPS guards |

**Frontend build-time:** `VITE_API_URL`, `VITE_SOCKET_URL`, `VITE_JOIN_CODE`.
These are inlined into the public bundle. Leave them empty for a same-origin
deployment. `VITE_JOIN_CODE` is a weak gate, not a secret.

---

## 3. Build and start

```bash
# Backend
cd server
npm ci
NODE_ENV=production \
CLIENT_ORIGIN=https://proxispeak.example.com \
SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" \
TRUST_PROXY=1 \
JOIN_CODE='<at least 12 chars>' \
node server.js

# Frontend
cd ..
npm ci
npm run build          # writes dist/
```

Startup validation is intentional and loud:

- invalid/missing `CLIENT_ORIGIN` → exit 1
- missing/short `SESSION_SECRET` → exit 1
- invalid `TRUST_PROXY` (not 0–3) → exit 1
- `TURN_URLS` without credentials, or `ICE_TRANSPORT_POLICY=relay` without TURN →
  exit 1
- missing `JOIN_CODE` with anonymous issuance disabled → warning + 503 on issuance

Warnings in development are labelled with `WARNING:`; fatal configuration errors
are `FATAL:`.

---

## 4. Health and smoke tests

```bash
# Liveness (aggregate only in production)
curl -fsS https://proxispeak.example.com/api/health
# {"ok":true,"service":"proxispeak-server","mongodb":"connected"}

# With HEALTH_TOKEN configured
curl -fsS -H "Authorization: Bearer $HEALTH_TOKEN" https://.../api/health
```

Deployment smoke checklist (run after every rollout):

1. `GET /api/health` returns `ok: true`.
2. `POST /api/auth/session` with the join code returns a token and `roomId`.
3. A browser on the deployed origin reaches `● CONNECTED · MIC OFF` in the
   office, and two browsers see each other's avatars.
4. Enabling the mic on both browsers produces `AUDIO LIVE` and audible speech.
5. `GET /api/ice` with the session token returns `turnEnabled: true` if TURN is
   configured.
6. Closing one browser removes its avatar from the other within a few seconds.
7. No secret appears in the browser bundle:
   `grep -rE "SESSION_SECRET|TURN_SECRET|JOIN_CODE" dist/` returns nothing
   (excluding the deliberate `VITE_JOIN_CODE` build if you chose to use it).

---

## 5. Database

MongoDB is optional for office/signalling operation. When `MONGODB_URI` is set:

- the watchdog pings every `MONGODB_WATCHDOG_MS`, reconnects with backoff, and
  reports the real state in `/api/health`;
- an outage does **not** stop presence, movement, or WebRTC signalling;
- credentials embedded in the URI are redacted from logs;
- the database name defaults to `proxispeak` (`mongodb://host:27017/proxispeak`).

### Initialization, indexes and migrations

There is **no migration framework and no seed step**. The collections are created
implicitly on first write, and `server/db.js` creates the indexes on every
successful connect (`createIndexes` is idempotent):

| Collection | Index | Purpose |
| --- | --- | --- |
| `users` | `{ email: 1 }` unique | one profile per email |
| `users` | `{ 'location.geometry': '2dsphere' }` | proximity queries |
| `offices` | `{ slug: 1 }` unique | office lookup by slug |
| `sessions` | `{ userId: 1, officeId: 1, startedAt: -1 }` | session history per user |
| `sessions` | `{ officeId: 1, endedAt: -1 }` | session history per office |

Two schema facts that are easy to get wrong:

1. The `2dsphere` index is on **`location.geometry`**, and
   `findUsersNearPosition()` queries that exact path with
   `$geoWithin: { $geometry: … }`. The top-level `officeId` field is what the
   proximity and online-user queries filter on; `location.officeId` is kept for
   convenience. If you change one of these paths, change the other and the index
   together, or queries will silently return nothing.
2. The GeoJSON coordinates are **virtual**, derived from the 0–100 floor
   percentages (`VIRTUAL_COORDS` in `server/db.js`). They are an internal artifact
   for the geospatial index and must never be presented to clients as real
   `lat`/`lng`.

Local MongoDB (free, no account) and the gated tests that exercise this path:

```bash
docker compose up -d mongo                 # mongo:7 on 127.0.0.1:27018
cd server
MONGODB_TEST_URI=mongodb://127.0.0.1:27018 npx vitest run db.live.test.js
PROXISPEAK_MONGO_RECOVERY=1 npx vitest run mongo-recovery.test.js
```

With the daemon unavailable those two suites skip themselves; they must not be
counted as passed. Restore from a normal MongoDB backup: the application stores
only profiles, office definitions and session history — never audio, and never
anything required for realtime operation.

Live and outage/recovery tests are gated:

```bash
cd server
MONGODB_TEST_URI=mongodb://127.0.0.1:27018 npx vitest run db.live.test.js
PROXISPEAK_MONGO_RECOVERY=1 npx vitest run mongo-recovery.test.js
```

---

## 6. Scaling notes

- Signalling is a single Node process with in-memory room/session maps. Running
  two instances without a shared adapter will split rooms and break session
  revocation (the revocation list is node-local).
- The peer mesh is O(n²): every participant connects to every other participant.
  Signalling load and browser media load are different budgets; do not infer one
  from the other.
- Before horizontal scaling: add a Socket.IO adapter (e.g. Redis), move session
  revocation to a shared store, and re-run the load tests across instances.

---

## 7. CI

`.github/workflows/ci.yml` runs install, frontend tests, backend tests, the
production build, and a bundle secret scan on push/PR. It is a template for a
standard Node runner; it has not been executed in this environment because no CI
provider is authenticated here.
