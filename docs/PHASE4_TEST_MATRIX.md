# ProxiSpeak — Test Matrix (Phase 4, final)

Every result below was produced by running the listed command in this
environment (Windows, Git Bash, Node 24) **after** the final source changes. A
check that could not be run is marked NOT RUN or BLOCKED rather than passed.

Legend: **VERIFIED** = executed with the result shown · **NOT RUN** = not
executed · **BLOCKED** = an external dependency prevents execution.

### Provenance of these results (release-verification pass)

| Result | When it was executed |
| --- | --- |
| Frontend unit suite (162) | Re-executed in the final verification pass via the documented `npm run test` |
| Backend suite (165 / 9 skipped) | Re-executed in the final verification pass via the documented `cd server && npm run test` |
| Build artifact + hash | Re-executed in the final verification pass; produced the **identical** bundle `dist/assets/index-Bxu1jpYt.js` (326.53 kB / 100.66 kB gzip). Identical content hashes mean the *shipped bundle* is the same artifact the browser suites exercised (the tests themselves are not bundled) |
| Dependency audits, secret scan, env-var cross-check, skip/debug scan | Re-executed in the final verification pass |
| `npm start` + `/api/health`, `npm run dev` + `/api` proxy, anonymous session issuance, invalid-room rejection | Re-executed in the final verification pass against the running app |
| Playwright desktop 37/7, mobile 38/6, fake-media 5 | Executed earlier in the same session, against the same application code now confirmed by the identical bundle hash. **Not re-executed in the final pass** because the only later changes were documentation and frontend *test* files, which cannot affect a browser run of the built app |
| Signaling load 20 / 50 clients | Executed earlier in the same session. The files in the serving path (`server.js`, `auth.js`, `config.js`, `ice.js`, `db.js`, `webrtc.js`) were not edited after that run; the only later backend addition is the standalone `mint-session.js` issuer, which nothing in the serving path imports |

Nothing in this matrix is carried over from the older Phase 3/Phase 2 reports.

---

## 1. Automated suites

| # | Check | Command | Result | Status |
| --- | --- | --- | --- | --- |
| 1 | Frontend unit tests × 5 consecutive | `cd proxispeak && npx vitest run` | 5/5 runs: exit 0, **12 files passed, 162 passed / 0 failed**, 0 `act()` warnings, ~11 s per run | VERIFIED |
| 2 | Backend unit + integration | `cd proxispeak/server && npx vitest run` | exit 0, **8 files passed / 2 skipped, 165 passed / 9 skipped** (skips: 6 `db.live` gated by `MONGODB_TEST_URI`, 2 `mongo-recovery` gated by `PROXISPEAK_MONGO_RECOVERY=1`, 1 pre-existing `it.skip` in `server.test.js`) | VERIFIED |
| 2b | Trusted-issuer minting (IdP boundary) | `cd proxispeak/server && npx vitest run mint-session.test.js` | exit 0, **7 passed** | VERIFIED |
| 2c | Dependency audit (server) | `cd proxispeak/server && npm audit` | **0 vulnerabilities** | VERIFIED |
| 2d | Dependency audit (frontend) | `cd proxispeak && npm audit` / `npm audit --omit=dev` | runtime deps: **0 vulnerabilities**; build toolchain: 7 advisories (2 moderate, 5 high) in Tailwind/PostCSS deps, fixable only by a breaking Tailwind 4 upgrade (`npm audit fix --dry-run` → "Will install tailwindcss@4.3.3, which is a breaking change") | VERIFIED (accepted risk, documented) |
| 2e | Lint / type-check | none configured — inspected `package.json` in both packages (no eslint/prettier/tsconfig) | no command exists to run | **NOT AVAILABLE** — not counted as a pass |
| 3 | Session-security integration | `cd proxispeak/server && npx vitest run session-security.test.js` | exit 0, **23 passed** | VERIFIED |
| 4 | Auth / startup / server / signaling | `cd proxispeak/server && npx vitest run auth.test.js startup.test.js server.test.js webrtc.test.js` | exit 0, all pass (subset of #2) | VERIFIED |
| 5 | ICE / TURN configuration | `cd proxispeak/server && npx vitest run ice.test.js` | exit 0, **16 passed** | VERIFIED |
| 6 | Production build | `cd proxispeak && npm run build` | exit 0, `dist/index.html` 0.46 kB, CSS 27.71 kB (6.91 gzip), JS 326.53 kB (100.66 gzip) | VERIFIED |
| 7 | Bundle secret scan | `grep -rEn "(SESSION_SECRET\|TURN_SECRET\|TURN_CREDENTIAL\|HEALTH_TOKEN)[[:space:]]*[:=][[:space:]]*[\"'][^\"']+\|proxispeak-development-only-session-secret\|mongodb(\+srv)?://[^\"']*@" dist/` | no match (`NO_SECRET_VALUE_IN_DIST`); only the *identifier* `SESSION_SECRET`/`CLIENT_ORIGIN` appears, inside a user-facing error string | VERIFIED |
| 8 | Playwright desktop | `cd proxispeak && npx playwright test --project=chromium-desktop` (backend :4000 + `vite preview` :4173) | exit 0, **37 passed / 7 skipped** (59.6 s) | VERIFIED |
| 9 | Playwright mobile | `npx playwright test --project=chromium-mobile` | exit 0, **38 passed / 6 skipped** (58.7 s) | VERIFIED |
| 10 | Playwright fake-media WebRTC | `npx playwright test tests/browser/webrtc-peer.spec.js tests/browser/webrtc-reliability.spec.js --project=chromium-desktop-fake-media` | exit 0, **5 passed** (1.0 m): full peer lifecycle, mic enable/disable cycles, socket-interruption reconnect + renegotiation, three-peer independent proximity gain | VERIFIED |
| 11 | Live MongoDB | `cd server && MONGODB_TEST_URI=mongodb://127.0.0.1:27018 npx vitest run db.live.test.js` | skipped (6) — no `mongod` binary and the Docker daemon is not running | BLOCKED |
| 12 | Mongo outage/recovery | `cd server && PROXISPEAK_MONGO_RECOVERY=1 npx vitest run mongo-recovery.test.js` | skipped (2) — same dependency | BLOCKED |
| 13 | Signaling load 20 clients | `cd server && node load-test.js --url http://127.0.0.1:4100 --clients 20 --duration 10 --hz 5 --rooms 1` | exit 0 — see §2 | VERIFIED |
| 14 | Signaling load 50 clients | `cd server && node load-test.js --url http://127.0.0.1:4100 --clients 50 --duration 15 --hz 2 --rooms 1` | exit 0 — see §2 | VERIFIED |
| 15 | Two real devices, audible audio | manual procedure in `PHASE4_TASK2_AUDIO_VALIDATION.md` | not performed (no second device/microphone) | NOT RUN |
| 16 | Real TURN relay connectivity | `ICE_TRANSPORT_POLICY=relay` + real coturn | no TURN server or credentials available | BLOCKED |
| 17 | Browser-media scalability (N real browser peers) | bounded multi-browser run | not performed (hardware/time budget) | NOT RUN |
| 18 | CI workflow execution | `.github/workflows/ci.yml` | never executed; no CI provider authenticated in this environment | NOT RUN |
| 19 | Local MongoDB via compose | `docker compose up -d mongo` | compose file added and YAML-validated, but the Docker daemon is not running here, so the service was never started | NOT RUN |

---

## 2. Signaling load results (actual)

Socket.IO clients only — no RTCPeerConnections, no audio. These numbers say
nothing about browser media capacity.

### 20 clients · 1 room · 10 s · 5 Hz per client

| Metric | Value |
| --- | --- |
| Clients connected | 20 / 20 |
| Session issuance latency (p50 / p95) | 8.84 ms / 13.74 ms |
| Socket connect latency (p50 / p95) | 4.28 ms / 5.87 ms |
| Room join latency (p50 / p95) | 1.30 ms / 2.21 ms |
| Position emits / acks | 980 / 980 (100 %) |
| Broadcast deliveries | 1 862 / s |
| Position RTT (p50 / p95 / p99 / max) | 7.61 / 15.00 / 16.75 / 23.24 ms |
| Signaling relay (sent / delivered) | 80 / 80, latency p50 1 ms / p95 3 ms |
| Server errors | 0 |
| Server RSS delta | +380 KB |
| Server CPU (fraction of one core) | 5.6 % |

### 50 clients · 1 room · 15 s · 2 Hz per client

| Metric | Value |
| --- | --- |
| Clients connected | 50 / 50 |
| Session issuance latency (p50 / p95) | 9.85 ms / 17.64 ms |
| Socket connect latency (p50 / p95) | 3.42 ms / 4.89 ms |
| Room join latency (p50 / p95) | 1.94 ms / 3.35 ms |
| Position emits / acks | 1 450 / 1 450 (100 %) |
| Broadcast deliveries | 4 736.7 / s |
| Position RTT (p50 / p95 / p99 / max) | 59.96 / 111.31 / 126.22 / 144.13 ms |
| Signaling relay (sent / delivered) | 80 / 80, latency p50 1 ms / p95 2 ms |
| Server errors | 0 |
| Server RSS delta | +1.6 MB |
| Server CPU (fraction of one core) | 16.9 % |

Notes:

- The 50-client position RTT is dominated by fan-out (one emit is delivered to 49
  peers) and by the load generator sharing the same CPU as the server. An earlier
  identical run on this machine measured p50 38 ms / p95 65 ms, so treat the
  absolute values as machine-load sensitive; the invariant is 100 % acks and 0
  server errors in both runs.
- No cleanup/connection failures were reported by the load script in either run.

---

## 3. What changed the numbers

Two client defects fixed during Phase 4 affect test stability rather than load:

1. `src/utils/socket.js` never forwarded handshake failures to the `onError`
   callback (`connect_error` looked up a listener that `connect()` never
   registers), so rejected sessions were silent in the UI.
2. The 162-test frontend suite previously emitted 16 `act()` warnings from
   asynchronously-completing session bootstrap updates in `render.test.jsx` and
   `persistence.test.jsx`; both now flush deterministically via
   `renderSettled()` in `src/__tests__/officeHarness.js`. Assertions are
   unchanged — the suite went from 153 to 162 tests because new tests were added
   for the fixed defects, not because any were removed.

---

## 4. Release gate

Run all of these before any rollout:

```bash
# 1. Suites
cd proxispeak && npm run test
cd server      && npm run test

# 2. Build + scan
cd .. && npm run build
grep -rEn "(SESSION_SECRET|TURN_SECRET|TURN_CREDENTIAL|HEALTH_TOKEN)[[:space:]]*[:=][[:space:]]*[\"'][^\"']+" dist/

# 3. Browser smoke (backend + preview running)
npx playwright test --project=chromium-desktop
npx playwright test --project=chromium-mobile
npx playwright test tests/browser/webrtc-peer.spec.js tests/browser/webrtc-reliability.spec.js --project=chromium-desktop-fake-media

# 4. Load (server running on :4100)
cd server && node load-test.js --clients 20 --duration 10 --hz 5
cd server && node load-test.js --clients 50 --duration 15 --hz 2
```

Any failure in steps 1–3 blocks release. Step 4 is a regression comparison
against §2, not a pass/fail gate.
