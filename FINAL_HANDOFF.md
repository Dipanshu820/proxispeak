# ProxiSpeak — Handoff

Everything needed to install, configure, run, test and troubleshoot the project
as it exists today. Verified on Windows (Git Bash / PowerShell) with Node 24.

Requires: **Node.js 22.12+ or 24+** and npm. Docker is optional (only for a local
MongoDB). No paid service, account, or credential is required for local
development.

The version floor comes from the installed tooling, not from preference: Vitest 5
declares `^22.12.0 || ^24.0.0 || >=26.0.0` (so Node 20 cannot run the test suites
at all), Vite 8 requires `^20.19.0 || >=22.12.0`, and Playwright requires >= 20.
Verified on **Node 24.18.0**. Odd-numbered Node releases above 22 are outside the
declared ranges.

---

## 1. Install

```bash
# from the repository root (the folder containing package.json)
npm install
cd server && npm install && cd ..
```

PowerShell: identical commands (`npm install`; `cd server; npm install; cd ..`).

## 2. Configure

Local development needs **no environment file** — omit `SESSION_SECRET` and the
server uses a clearly-labelled development-only secret and issues anonymous
sessions for any valid room.

Optional local file: copy `server/.env.example` to `server/.env` and fill in only
what you need. Nothing loads `.env` automatically (there is no dotenv dependency);
export variables in your shell or process manager instead:

```bash
# PowerShell
$env:SESSION_SECRET = "dev-secret-at-least-32-characters-long"
$env:PORT = "4000"

# Git Bash
export SESSION_SECRET="dev-secret-at-least-32-characters-long"
export PORT=4000
```

Production-required (see `docs/PHASE4_DEPLOYMENT.md`): `NODE_ENV=production`,
`CLIENT_ORIGIN` (bare `https:` origin), `SESSION_SECRET` (>= 32 chars),
`TRUST_PROXY` (hop count), and `JOIN_CODE` or an upstream issuer.

## 3. Run

Two terminals:

```bash
# Terminal A — backend (http://localhost:4000)
cd server
npm run dev          # or: npm start

# Terminal B — frontend (http://localhost:5173)
npm run dev
```

Open **http://localhost:5173**, click **Enter Office**, then **Enable mic** on two
browsers/windows to hear proximity audio. Audio only works on `localhost` or
HTTPS: browsers refuse `getUserMedia` on plain-HTTP remote hosts.

Production-style local run:

```bash
npm run build
npx vite preview --port 4173 --host 127.0.0.1   # serves dist/ and proxies /api
```

## 4. Test

```bash
# Frontend unit/component (12 files, ~11 s)
npm run test

# Backend unit + integration (10 files: 8 run, 2 gated suites skipped;
# 165 passed / 9 skipped unless the gated dependencies exist)
cd server && npm run test

# Production build
npm run build

# Browser tests — needs the backend AND the preview server running
cd server && npm start                     # terminal A
npx vite preview --port 4173 --host 127.0.0.1   # terminal B
npx playwright test --project=chromium-desktop
npx playwright test --project=chromium-mobile
npx playwright test tests/browser/webrtc-peer.spec.js tests/browser/webrtc-reliability.spec.js --project=chromium-desktop-fake-media

# Optional: real MongoDB (gated tests)
docker compose up -d mongo
cd server
MONGODB_TEST_URI=mongodb://127.0.0.1:27018 npx vitest run db.live.test.js
PROXISPEAK_MONGO_RECOVERY=1 npx vitest run mongo-recovery.test.js

# Signaling load (bounded; server must be running)
cd server && node load-test.js --clients 20 --duration 10 --hz 5 --rooms 1
```

PowerShell equivalents: same commands; set env vars with `$env:NAME = "value"`
instead of a leading `NAME=value`.

## 5. Mint a session without the development issuer

For a pilot or an identity provider integration (see `docs/PHASE4_SECURITY.md`
§1 — the server never authenticates a human by itself):

```bash
cd server
SESSION_SECRET="<same value the server uses>" npm run mint-session -- \
  --room design-team --name "Alice" --subject idp-user-42 --ttl 3600
```

The command prints JSON containing a `token`. **That token is a credential** —
hand it to the browser, never paste it into a report, ticket, or log.

## 6. Troubleshoot

| Symptom | Cause | Fix |
| --- | --- | --- |
| Header shows `● DISCONNECTED` | backend not running, or the session request failed | start `server/`, then check the browser console and `POST /api/auth/session` status |
| `Secure session unavailable (…)` in the UI | the code in parentheses is the real reason: `AUTH_UNAVAILABLE`, `HTTP_403`, `INVALID_JOIN_CODE`, … | see the table below |
| `403 ORIGIN_FORBIDDEN` | the page origin is not in `CLIENT_ORIGIN` | add the exact bare origin; development already allows `localhost`/`127.0.0.1` on any port |
| `403 HTTPS_REQUIRED` | production request not seen as HTTPS | set `TRUST_PROXY=1` and have the proxy send `X-Forwarded-Proto` |
| `503 AUTH_NOT_CONFIGURED` | production without `JOIN_CODE` and anonymous issuance disabled | set `JOIN_CODE` or mint sessions upstream |
| `FATAL: SESSION_SECRET is required…`, exit 1 | production without a signing secret | 32+ chars: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `EADDRINUSE` on start | port 4000 already used | find and stop it: `netstat -ano \| findstr :4000` then `taskkill /PID <pid> /F` (PowerShell), or `netstat -ano \| grep :4000` then `taskkill //PID <pid> //F` (Git Bash) |
| Both avatars visible but no sound | mic not enabled, peers outside the 100 px earshot, or one side muted | enable the mic on **both** sides and move the avatars closer |
| `Microphone access failed` | denied permission, or the page is not on localhost/HTTPS | grant permission; use `http://localhost` (not a LAN IP over http) |
| Playwright tests fail immediately | backend/preview not running, or `dist/` is stale | start both servers and re-run `npm run build` |
| `db.live.test.js` / `mongo-recovery.test.js` skipped | no MongoDB (`MONGODB_TEST_URI` unset) | `docker compose up -d mongo`, then follow §4 |
| Audio connects on LAN but not across NATs | STUN alone cannot traverse symmetric NATs | configure `TURN_URLS` + `TURN_SECRET` (see `docs/PHASE4_DEPLOYMENT.md`) |

Diagnostics without reading the console: in DevTools run
`window.__proxispeakWebrtc.getPeerDiagnostics()` — it reports `connectionState`,
`audioGraph`, `gain`, `transceivers` and `audioContextState`, and exposes no
media, SDP, token, or credential.

## 7. Where things are

| Topic | Document |
| --- | --- |
| Deploy, env vars, reverse proxy, smoke tests | `docs/PHASE4_DEPLOYMENT.md` |
| Security model, identity boundary, session lifecycle | `docs/PHASE4_SECURITY.md` |
| On-call procedures and incident playbooks | `docs/PHASE4_OPERATIONS_RUNBOOK.md` |
| Every check, command and result | `docs/PHASE4_TEST_MATRIX.md` |
| Rollback triggers and procedure | `docs/PHASE4_ROLLBACK.md` |
| What was done in the Phase 4 execution | `PHASE4_EXECUTION_LOG.md`, `PHASE4_FINAL_COMPLETION_REPORT.md` |
