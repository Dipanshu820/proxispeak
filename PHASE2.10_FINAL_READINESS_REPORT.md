# ProxiSpeak Phase 2.10: Final Frontend Regression and Readiness Audit

**Date:** October 16, 2026
**Investigator:** Buffy (AI Testing Agent)
**Decision:** READY FOR FRONTEND BASELINE

---

## 1. Files Inspected

### Test files (Phase 2.9 changes)
- **`src/__tests__/interaction.test.jsx`** — Restructured "moves in all four directions" test. Render once, release previous key between iterations, pump frames, assert. No uninstall/re-install or cleanup/render between iterations.
- **`src/__tests__/officeHarness.js`** — Added `clearFrames()` method (present but now unused by the fixed test; harmless).
- **`src/__tests__/setup.js`** — Unchanged. `beforeEach` calls `cleanup()` + `localStorage.clear()`.

### Production file (inspected, not modified)
- **`src/pages/VirtualOffice.jsx`** — Animation-frame effect (lines 210–296) inspected. The effect:
  - Depends on `[floorSize]`
  - Creates `animate` closure capturing `keysRef`, `floorRef`, `floorSize`, `setPeople`
  - On mount: checks floor dimensions, pushes initial `requestAnimationFrame(animate)`
  - `animate`: reads `keysRef.current`, computes movement, calls `setPeople` with clamped/resolved position, then `requestAnimationFrame(animate)` to schedule next frame
  - Cleanup on unmount: `cancelAnimationFrame(animationId)` — stubbed to no-op in tests
  - Cleanup on `floorSize` change: React re-runs the effect, which calls `cancelAnimationFrame(animationId)` for the old loop, then starts a new one

No production defect was found. The animation loop correctly self-schedules, self-cancels on unmount, and re-starts when floor size changes.

---

## 2. Verification of Phase 2.9 Fix Correctness

### 2.1 `clearFrames()` correctness
`clearFrames()` sets `frames = []`, discarding only the queued animation callbacks in the harness's closure. It does NOT:
- Touch `vi.stubGlobal` state
- Touch `rectSpy` state
- Touch `setPointerCapture`/`releasePointerCapture` overrides
- Modify `clock` state

It is scoped to the harness instance returned by `installOfficeHarness()`. The fixed test no longer calls it (the same component instance is reused, so no stale callbacks accumulate). The method remains available for other tests that may need it.

### 2.2 Global stubs and spies restoration
- **Between iterations within the fixed test:** No restoration happens. The same harness instance (and its stubs) persist across all 8 iterations. This is intentional and correct — the stubs are needed for every iteration.
- **Between tests:** `afterEach` calls `harness?.uninstall()` which calls `rectSpy.mockRestore()`, deletes `setPointerCapture`/`releasePointerCapture`, and calls `vi.unstubAllGlobals()`. This restores all globals and spies. `setup.js` `beforeEach` then calls `cleanup()` (React tree cleanup) + `localStorage.clear()`.
- **Cleanup order:** `afterEach` (test-level teardown) → `beforeEach` (next test setup). Correct.

### 2.3 No stale state leakage
- **Animation callbacks:** The fixed test keeps one component instance. The animation callback queue naturally drains and re-fills each iteration (each `pumpFrames(4)` frame's `animate` schedules the next). No stale callbacks accumulate because the same `animate` function is always re-scheduled.
- **Timers:** `VirtualOffice.jsx` has a `setInterval` for colleague jitter (4200ms). `cleanup()` unmounts the component, triggering the interval's `clearInterval` cleanup. No timer leaks between tests.
- **Pointer capture overrides:** `Element.prototype.setPointerCapture` and `releasePointerCapture` are set to `vi.fn()` by the harness and deleted by `uninstall()`. Between tests, `uninstall()` runs in `afterEach`, restoring the originals.
- **DOM elements:** `cleanup()` unmounts the React tree, removing all rendered DOM. `setup.js` `beforeEach` also calls `cleanup()` as a safety net. No DOM leakage.

### 2.4 Correct key release between iterations
The fixed test tracks `previousKey` and calls `keyUp(previousKey)` before pressing the next key. This ensures only one key is held at a time. The first iteration has no `previousKey`, so no `keyUp` is called (correct — no key is held before the test starts).

### 2.5 Assertions verify actual movement
Each iteration asserts `(now[axis] - start[axis]) * sign > 0.2`. This verifies the avatar moved at least 0.2% in the expected direction. With `MOVE_SPEED_PX_PER_SEC = 90` and 4 frames at 20ms each (80ms total), the expected movement is approximately `90 * 0.08 / 900 * 100 = 0.8%` — well above the 0.2% threshold. All 8 directions (d, a, w, s, ArrowRight, ArrowLeft, ArrowUp, ArrowDown) are tested.

---

## 3. Confirmed Root Cause vs. Unresolved Hypotheses

### 3.1 Confirmed root cause
**Repeated `vi.unstubAllGlobals()` calls in the test loop caused intermittent timeouts.**

Evidence:
- The original test called `harness.uninstall()` (which calls `vi.unstubAllGlobals()`) 8 times per test run
- The test timed out at 5000ms intermittently (observed: 5175ms in one full-suite run)
- Removing the uninstall/re-install cycle (fix 1: `cleanup()` + `clearFrames()` + `render()`) reduced but did NOT eliminate timeouts (still timed out at 5331ms)
- Removing the render cycle entirely (fix 2: render once, release keys, pump frames) eliminated timeouts completely (10/10 isolation passes, 2/2 full suite passes)
- The timing improvement tracks with removing React mount/unmount overhead, not just `vi.unstubAllGlobals()`

### 3.2 What was NOT confirmed as the sole cause
**`vi.unstubAllGlobals()` alone was not definitively proven to be the sole cause.** The first fix attempt (keeping harness installed, using cleanup+render) removed `vi.unstubAllGlobals()` from the loop but still timed out. This shows that React re-render overhead also contributes. The definitive cause is the **combination** of:
1. Repeated `vi.unstubAllGlobals()` calls (expensive)
2. Repeated React unmount/remount cycles (expensive)
3. Both happening 8 times in one test

The final fix removes both by rendering once and reusing the component.

### 3.3 Hypotheses ruled out
- **Production code defect:** Ruled out — `VirtualOffice.jsx` was not modified and the animation logic is straightforward (read keys, compute delta, setPeople, schedule next frame).
- **Test assertion too strict:** Ruled out — the 0.2% threshold is far below the expected 0.8% movement. The assertion never failed on its own; only the timeout failed.
- **`clearFrames()` losing the initial callback:** Confirmed as a real issue with the intermediate fix (fix 1), but resolved in the final fix by not calling `clearFrames()` at all.

---

## 4. Exact Verification Results

### 4.1 Full unit suite — Run 1
```bash
cd proxispeak && npm test -- --pool=forks
```
**Exit code:** 0
**Result:** Test Files 8 passed (8), Tests 117 passed (117)
**Duration:** 16.85s
**Keyboard test:** "moves in all four directions with WASD and the arrow keys" — ✓ 2979ms

### 4.2 Full unit suite — Run 2
```bash
cd proxispeak && npm test -- --pool=forks
```
**Exit code:** 0
**Result:** Test Files 8 passed (8), Tests 117 passed (117)
**Duration:** 18.79s
**Keyboard test:** "moves in all four directions with WASD and the arrow keys" — ✓ 2443ms

### 4.3 Keyboard test in isolation — 10 consecutive runs
```bash
cd proxispeak && for i in $(seq 1 10); do npx vitest run src/__tests__/interaction.test.jsx -t "moves in all four directions" --pool=forks; done
```
**Result:** 10/10 passed, 0 failures
**Sample timing:** 878ms (single run observed)

### 4.4 Build
```bash
cd proxispeak && npm run build
```
**Exit code:** 0
**Result:** ✓ built in 3.88s
```
dist/index.html                   0.46 kB │ gzip: 0.30 kB
dist/assets/index-DgC9Y48R.css   27.25 kB │ gzip: 6.82 kB
dist/assets/index-DIxldlDD.js   266.87 kB │ gzip: 82.40 kB
```

### 4.5 Desktop Playwright suite
```bash
cd proxispeak && npx playwright test --project=chromium-desktop
```
**Exit code:** 0
**Result:** 33 passed, 2 skipped, 0 failed
**Duration:** 57.5s

### 4.6 Mobile Playwright suite
```bash
cd proxispeak && npx playwright test --project=chromium-mobile
```
**Exit code:** 0
**Result:** 34 passed, 1 skipped, 0 failed
**Duration:** 1.1m

---

## 5. Global State and Animation-Frame Leakage Assessment

**No leakage was demonstrated.** All of the following were verified:

| Concern | Status | Evidence |
|---------|--------|----------|
| Global stubs (rAF, cancelAnimationFrame) | ✅ Restored | `uninstall()` → `vi.unstubAllGlobals()` in `afterEach` |
| `getBoundingClientRect` spy | ✅ Restored | `rectSpy.mockRestore()` in `uninstall()` |
| `setPointerCapture`/`releasePointerCapture` overrides | ✅ Removed | `delete Element.prototype.*` in `uninstall()` |
| Stale animation callbacks | ✅ None | Same component instance reused; queue drains naturally each iteration |
| Stale timers (setInterval) | ✅ Cleared | `cleanup()` unmounts component → `clearInterval` runs |
| Stale pointer capture state | ✅ Restored | `uninstall()` deletes prototype overrides |
| DOM elements from previous test | ✅ Removed | `cleanup()` unmounts React tree; `setup.js` `beforeEach` calls `cleanup()` as safety net |
| Keyboard event listeners | ✅ Removed | Component's `useEffect` cleanup removes window listeners on unmount |
| `keysRef` state | ✅ Reset | New component instance has fresh `useRef({})` |

---

## 6. Files Changed

### Phase 2.9 (carried into Phase 2.10)
- **`src/__tests__/interaction.test.jsx`** — Restructured "moves in all four directions" test: render once, release previous key between iterations, pump frames, assert. Removed `cleanup()` + `render()` cycle between iterations.
- **`src/__tests__/officeHarness.js`** — Added `clearFrames()` method. (Present but unused by the fixed test.)

### No other files changed.
No production code changed. No browser test files changed. No configuration files changed.

---

## 7. Desktop and Mobile Browser-Test Status

**Freshly verified this run — not carried forward.**

| Suite | Result | Duration |
|-------|--------|----------|
| Desktop (chromium-desktop) | 33 passed, 2 skipped, 0 failed | 57.5s |
| Mobile (chromium-mobile) | 34 passed, 1 skipped, 0 failed | 1.1m |

The mobile touch drag test (test 14 in the mobile suite) passes at 1.4s, confirming the Phase 2.8 fix remains stable.

---

## 8. Remaining Manual Checks

The following remain unverified by automation and require manual testing:

1. **Microphone meter with real audio:** Chrome's `--use-fake-device-for-media-stream` produces silence. No command-line flag generates test audio. The meter behavior with actual audio input cannot be verified in automation. Requires real microphone hardware.

2. **Mobile touch on physical devices:** The automated test uses synthetic `TouchEvent` dispatched via `page.evaluate()`. This does not test real touchscreen behavior (finger pressure, touch radius, scroll prevention, gesture recognition, touch cancellation). Requires manual testing on iOS and Android hardware.

3. **Mobile touch on non-Chromium browsers:** The Playwright suite runs only on Chromium. Safari Mobile and Firefox Mobile touch behavior is not verified.

4. **Touch edge cases on real devices:** Touch cancel, multi-touch, and touch interrupt behaviors are not tested by the current automated suite.

---

## 9. Final Status

### All automated checks pass ✅

| Check | Result |
|-------|--------|
| Unit suite (2 runs) | 117/117, 8/8 files, 0 failures |
| Keyboard test isolation (10 runs) | 10/10 passed, 0 failures |
| Build | ✓ passed (3.88s) |
| Desktop Playwright | 33 passed, 2 skipped, 0 failed |
| Mobile Playwright | 34 passed, 1 skipped, 0 failed |
| Global state leakage | None demonstrated |
| Animation-frame leakage | None demonstrated |

### Verified interaction coverage

| Category | Status |
|----------|--------|
| Keyboard movement (WASD + arrows, all 8 directions) | ✅ Verified by automated test |
| Keyboard stop on release / blur | ✅ Verified by automated test |
| Keyboard input guards (focused inputs) | ✅ Verified by automated test |
| Diagonal speed limiting | ✅ Verified by automated test |
| Pointer drag (desktop) | ✅ Verified by automated test |
| Furniture collision (drag + keyboard) | ✅ Verified by automated test |
| Floor boundary clamping | ✅ Verified by automated test |
| Proximity detection | ✅ Verified by automated test |
| Microphone state UI (button, toggle, meter element) | ✅ Verified by automated test |
| Layout persistence (reset) | ✅ Verified by automated test |
| Responsive layout | ✅ Verified by automated test |
| Colleague list | ✅ Verified by automated test |
| **Microphone meter with real audio** | ❌ Manual only |
| **Mobile touch on physical device** | ❌ Manual only |
| **Mobile touch on non-Chromium browsers** | ❌ Manual only |

---

## 10. Decision

**READY FOR FRONTEND BASELINE**

All required automated checks pass:
- Unit suite: 117/117 tests, 8/8 files, 0 failures (2 consecutive full runs)
- Keyboard test: 10/10 isolation runs pass, 0 timeouts
- Build: passes
- Desktop Playwright: 33/35 pass, 2 skipped, 0 fail
- Mobile Playwright: 34/35 pass, 1 skipped, 0 fail

No global state or animation-frame leakage was demonstrated. Every test restores globals, spies, pointer-capture overrides, and DOM state. The Phase 2.9 fix resolves the only failing test (keyboard direction timeout) by rendering once and releasing keys between iterations, eliminating the expensive repeated uninstall/re-install and React remount cycles.

**Remaining limitations are confined to manual-only verification (microphone meter with real audio, mobile touch on physical devices, non-Chromium mobile browsers). These are pre-existing limitations that do not affect the automated baseline.**

**Phase 3 is not started.**
