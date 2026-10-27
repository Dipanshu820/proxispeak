# ProxiSpeak — Security Model (Phase 4)

> **Update:** the office is now account-based. Signup/login, scrypt password
> hashing, HttpOnly cookie sessions and logout revocation are documented in
> `docs/AUTH_AND_3D.md`; statements below that describe the application session
> as the only credential predate that change.

This describes the security controls that exist in the code today, their exact
scope, and what remains out of scope. It is written to match
`server/auth.js`, `server/config.js`, `server/server.js`, `server/webrtc.js`,
`server/ice.js` and the client modules.

---

## 1. Identity boundary (read this first)

ProxiSpeak has an **application session**, not user accounts.

- `POST /api/auth/session` mints an HMAC-SHA256 signed, expiring token.
- The **subject (`sub`) is generated server-side** (`crypto.randomUUID()`); the
  client cannot choose or change it.
- The display name is untrusted text: it is sanitised (control characters
  stripped, 40-char cap) and then signed into the token, so it cannot be changed
  after issuance.
- The token is bound to **one room** and one `jti`.

What this proves: the bearer obtained a session from this server and may join
that room.

What this does **not** prove: that the bearer is a particular human. There is no
password store, email verification, SSO, or user directory. In production,
sessions are only issued when `JOIN_CODE` is configured (or anonymous issuance is
explicitly enabled); a real identity provider must mint these tokens for any
deployment that needs verified people. The token format and signing routine are
the integration boundary (`issueSession`).

---

## 2. Session token lifecycle

| Property | Implementation |
| --- | --- |
| Format | `v1.<base64url(claims)>.<base64url(HMAC-SHA256)>` |
| Claims | `{ v, sub, name, room, jti, iat, exp }` |
| Default lifetime | 3600 s; bounded 60–86400 s |
| Signature check | constant-time comparison, strict base64url (non-malleable) |
| Replay/eavesdrop | token kept in memory only (no localStorage) |
| Handshake | every socket must present a valid token; rejected sockets never reach any handler |
| Live expiry | the server sets a timer per socket and disconnects it at `exp` (with `session:expired` first) |
| Revocation | `POST /api/auth/revoke` adds the `jti` to an in-memory list, checks it at handshake and on `/api/ice`, and disconnects matching live sockets |

### Revocation limits — stated plainly

- It is **node-local, in-memory** state. A second instance will still accept the
  revoked token, and a restart forgets revocations.
- Tokens remain bounded by `exp`, so the worst case after a restart is the
  configured TTL, never indefinite access.
- There is no admin/global "log out everyone" endpoint. `POST /api/auth/revoke`
  revokes the token that authorises the request.
- Do not claim "instant revocation" for a multi-instance deployment until the
  list is shared (Redis/DB) or revocation happens at the edge.

### Client recovery

`src/utils/socket.js` reacts to `session:expired` and to `AUTH_EXPIRED` handshake errors by
minting a fresh session for the same room and reconnecting once. Other auth
errors (bad signature, malformed, revoked) are surfaced to the UI and are not
retried in a loop.

---

## 3. Room isolation

Rooms are the only authorization boundary and every room-scoped operation checks
them server-side:

| Event | Checks |
| --- | --- |
| `office:join` | token room == requested room; room is on `ALLOWED_ROOMS`; one live socket per subject (older socket evicted) |
| `position:update` | `socket.data.roomId` set; per-socket rate limit (20/s); finite numeric coordinates; clamped to 0–100 |
| `speaking:update` | `socket.data.roomId` set; boolean payload |
| `webrtc:initiate` / `webrtc:offer` / `webrtc:accept` / `webrtc:ice-candidate` | sender is in a room; target is connected, authenticated, and in the *same* room; answers require a server-recorded offer from the initiator (no third-party injection); payload size caps; per-socket signalling rate limit (120 / 10 s) |
| `office:leave` | clears `roomId`/`user` and notifies the room, so later events fail the same guards |

The server never trusts a client-supplied participant id or name: identity comes
from the verified token, and the broadcast userId is the server-assigned socket
id.

Frontend visibility is never treated as authorization. All of the above is
enforced in `server/server.js` and `server/webrtc.js` regardless of what the
client renders.

---

## 4. HTTP controls

### Origin validation

Applied to every `POST/PUT/PATCH/DELETE` under `/api` **in addition to CORS**:

- a request that carries an `Origin` not in `CLIENT_ORIGIN` is rejected with
  `403 ORIGIN_FORBIDDEN`;
- requests without an `Origin` (curl, load tests, server-to-server) are allowed,
  because they are not CSRF-able;
- development additionally accepts loopback `http:` origins on any port (dev
  server 5173, `vite preview` 4173, browser tests). Production does not.

CORS alone is not treated as authorization: it decides whether a browser may read
a response, not whether a cross-site request gets processed.

### HTTPS

- In production, `/api/auth/session`, `/api/auth/revoke` and `/api/ice` require
  `req.secure` and answer `403 HTTPS_REQUIRED` otherwise.
- `req.secure` only reflects `X-Forwarded-Proto` when `TRUST_PROXY` declares the
  hop count. It is **off by default**, so a forged `X-Forwarded-Proto: https`
  cannot upgrade a plaintext request.
- `TRUST_PROXY` accepts only an integer 0–3. Names (`true`, `loopback`, `*`) are
  rejected and the process exits 1.
- The deliberate escape hatches are `REQUIRE_HTTPS=false` and
  `PROXISPEAK_ALLOW_HTTP_ORIGIN=true`; both are documented downgrades.

### Response headers

`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`X-Frame-Options: DENY`, and in production
`Strict-Transport-Security: max-age=31536000; includeSubDomains`.

### Other HTTP limits

- JSON bodies capped at 16 KiB.
- Socket.IO `maxHttpBufferSize` 256 KiB; SDP/ICE payloads capped at 64 KiB.
- Session issuance is rate limited per IP (240 per 60 s window).
- Session responses are `Cache-Control: no-store`.
- `x-powered-by` disabled.
- Production `/api/health` exposes only `{ ok, service, mongodb }`; memory/CPU/
  port/auth diagnostics are development-only and contain no secrets.

---

## 5. Secrets

| Secret | Where it lives | Client-visible? |
| --- | --- | --- |
| `SESSION_SECRET` | server env only | no |
| `JOIN_CODE` | server env, sent as a request header | only if `VITE_JOIN_CODE` is deliberately baked into a build |
| `TURN_SECRET` / static TURN credentials | server env only | ephemeral TURN credentials are issued per session via `/api/ice`; the shared secret is never sent |
| `MONGODB_URI` | server env only | no; redacted in logs |
| `HEALTH_TOKEN` | server env only | no |

- No supported secret is compiled into `dist/`; this is checked by a bundle scan
  in the final regression.
- `server/.env.example` contains placeholders only.
- Logs never print tokens or secrets; MongoDB URIs are redacted
  (`//***@`).
- Production startup fails closed when `SESSION_SECRET` is missing or weak.

---

## 6. Media security

- Audio is peer-to-peer WebRTC; nothing is recorded or stored server-side.
- TURN credentials are short-lived and scoped to the session subject.
- Media authorization is inherently client-side in a mesh: the server authorises
  *signalling* between room members, but once two peers connect, whether audio
  flows is a browser matter. A hostile participant in the room can always choose
  not to send audio; they cannot join a room their token does not name.

---

## 7. Known gaps / accepted risks

| Gap | Impact | Mitigation |
| --- | --- | --- |
| No identity provider | Sessions identify a browser, not a person | Integrate an IdP that mints these tokens; keep `sub` server-controlled |
| In-memory revocation | Revocation not shared across instances/restarts | Share the store or revoke at the edge before scaling out |
| `VITE_JOIN_CODE` bundling | Join code is extractable from the bundle | Use a server-side IdP or rotate the code; treat it as a weak gate |
| No per-user room ACL | All session holders in a room are peers | Issue per-room tokens only to authorised users at the IdP |
| Mesh media O(n²) | Large rooms are a client-cost problem | SFU (LiveKit/mediasoup) for scale |
| No TURN relay verified here | Restrictive NATs may fail to connect | Configure and verify TURN with `ICE_TRANSPORT_POLICY=relay` |
| No WAF/DDoS protection in app | Public exposure risk | Terminate at a proxy/CDN with rate limits |
