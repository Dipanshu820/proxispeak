# ProxiSpeak — Rollback Plan (Phase 4)

Applies to a deployment of `server/server.js` plus the static `dist/` build. The
application keeps no schema migrations and no authoritative session state on
disk, so rollback is primarily "run the previous artifact with the previous
configuration".

---

## 1. Rollback triggers

Roll back (or disable the new configuration) if any of these persist after the
first post-deploy smoke test:

- the process exits at startup (`FATAL:` in logs) and the cause is not a
  one-line configuration fix;
- `/api/health` reports `ok: false` while the database is known-good;
- session issuance fails for legitimate users (`401/403/503`) after the proxy and
  join code are verified;
- two browsers in the same room cannot see each other, or audio cannot be
  established with a previously working network profile;
- error rate or position RTT regresses far beyond the measured baseline
  (see `docs/PHASE4_TEST_MATRIX.md`) for the same client count;
- a secret is found in the bundle, logs, or a response body.

Do **not** roll back for expected behaviour: `AUTH_EXPIRED` refresh cycles,
`403 HTTPS_REQUIRED` when `TRUST_PROXY` is unset in production, or TURN being
disabled on a deployment that never configured it.

---

## 2. Immediate mitigations before a full rollback

| Symptom | Fast mitigation |
| --- | --- |
| HTTPS guard blocks legitimate traffic | set `TRUST_PROXY` to the real hop count and restart; confirm the proxy sends `X-Forwarded-Proto` |
| Origin guard blocks the frontend | add the exact bare origin to `CLIENT_ORIGIN` and restart |
| Join code lost / leaked | rotate `JOIN_CODE` (and rebuild if `VITE_JOIN_CODE` is used) |
| Leaked session token | `POST /api/auth/revoke` with that token; rotate `SESSION_SECRET` to invalidate everything |
| TURN misconfiguration blocks startup | unset `TURN_URLS` (STUN-only) and restart, then fix credentials |
| Database outage | leave the app running; persistence is optional and the watchdog recovers |
| Signalling overload | reduce room size / stop non-essential broadcasters; scaling out requires a shared adapter |

---

## 3. Full rollback procedure

1. **Freeze**: stop promoting new builds; keep the current process running only
   as long as it is not causing harm.
2. **Identify the previous known-good artifacts**: previous `dist/` build and
   previous backend commit/package. There is no committed baseline in this
   working tree, so keep deployment artifacts versioned outside the repo.
3. **Restore configuration first** if the failure is config-only: previous
   environment file, then restart.
4. **Deploy the previous backend**, with its matching `.env`:
   ```bash
   NODE_ENV=production \
   CLIENT_ORIGIN=https://proxispeak.example.com \
   SESSION_SECRET="$PREVIOUS_SECRET" \
   TRUST_PROXY=1 \
   JOIN_CODE="$JOIN_CODE" \
   node server.js
   ```
5. **Deploy the matching previous `dist/`** so client and server agree on the
   API/session contract.
6. **Verify**:
   - `/api/health` → `ok: true`
   - session issuance → `200` with a token
   - two browsers join the same room and see each other
   - mic enable → `AUDIO LIVE`, audible speech on a known-good network
7. **Communicate**: record the rollback reason, the artifact versions restored,
   and the follow-up owner.

---

## 4. Data considerations

- No database migrations are applied by this application; rolling back the code
  does not require a data migration.
- MongoDB documents (profiles, offices, session history) are additive. A
  rollback does not delete them.
- Sessions are stateless tokens. Rolling back `SESSION_SECRET` invalidates all
  tokens issued under the other secret; users will be asked to rejoin. That is
  expected and safe.
- The in-memory revocation list is lost on any restart. Revoked tokens become
  valid again until their `exp`; keep TTLs short or rotate the signing secret.

---

## 5. After rollback

- Capture logs and the exact failing request/response (no tokens, no secrets).
- Reproduce locally with the same configuration, including `TRUST_PROXY` and
  `CLIENT_ORIGIN`.
- Add a regression test for the failure before re-attempting the rollout.
- Re-run the release gate in `docs/PHASE4_TEST_MATRIX.md` before trying again.
