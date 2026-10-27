// Two-browser WebRTC integration test.
//
// Runs only in the `chromium-desktop-fake-media` project, which launches Chromium
// with --use-fake-device-for-media-stream and --use-fake-ui-for-media-stream.
//
// What this proves: two independent browser contexts complete a real offer /
// answer / ICE exchange, both RTCPeerConnections reach `connected`, remote audio
// tracks arrive in the receiving pipeline, proximity changes the gain node, and
// cleanup removes peers and audio graph nodes.
//
// What this does NOT prove: that a human can hear usable audio. Chrome's fake
// device produces silence, so nothing here asserts audibility — only that the
// media path exists and is wired. Audible verification needs real microphones
// (manual procedure in PHASE3.9_VERIFICATION_REPORT.md).
import { test, expect } from '@playwright/test'
import { SELECTORS, signInAndEnterOffice, waitForOfficeReady, getAvatarCenter } from './helpers.js'

// The floor holds two avatars once a peer joins (both are named "You"), so the
// shared dragAvatar helper's name-based locator is ambiguous here. These helpers
// address the local avatar (aria-current) and the remote one explicitly.
const LOCAL_AVATAR = '.office-floor [aria-label^="You,"][aria-current="true"]'
const REMOTE_AVATAR = '.office-floor [aria-label^="You,"]:not([aria-current="true"])'

async function avatarGap(page) {
  const local = await page.locator(LOCAL_AVATAR).first().boundingBox()
  const remote = await page.locator(REMOTE_AVATAR).first().boundingBox()
  if (!local || !remote) return null
  return {
    dx: remote.x + remote.width / 2 - (local.x + local.width / 2),
    dy: remote.y + remote.height / 2 - (local.y + local.height / 2),
    distance: Math.hypot(
      remote.x + remote.width / 2 - (local.x + local.width / 2),
      remote.y + remote.height / 2 - (local.y + local.height / 2),
    ),
  }
}

// Walk the local avatar with the keyboard. Keyboard movement is the same input
// path the rest of the suite uses, and it avoids pointer-capture quirks in
// headless Chromium. Furniture can block a direction, so both helpers probe all
// four directions first and then keep the one that actually helps.
async function pressSteps(page, key, steps) {
  for (let i = 0; i < steps; i += 1) {
    await page.keyboard.down(key)
    await page.waitForTimeout(120)
    await page.keyboard.up(key)
  }
}

async function probeBestDirection(page, { maximize }) {
  let best = { key: 'a', distance: (await avatarGap(page))?.distance ?? 0 }
  for (const key of ['a', 'd', 'w', 's']) {
    await pressSteps(page, key, 2)
    const gap = await avatarGap(page)
    if (!gap) return best
    const better = maximize ? gap.distance > best.distance : gap.distance < best.distance
    if (better) best = { key, distance: gap.distance }
  }
  return best
}

async function walk(page, { target, maximize, maxSteps = 60 }) {
  let { key, distance } = await probeBestDirection(page, { maximize })
  for (let step = 0; step < maxSteps; step += 1) {
    const reached = maximize ? distance >= target : distance <= target
    if (reached) return distance
    await pressSteps(page, key, 1)
    const gap = await avatarGap(page)
    if (!gap) return null
    const improved = maximize ? gap.distance > distance + 0.5 : gap.distance < distance - 0.5
    distance = gap.distance
    if (!improved) {
      // Blocked: try every direction again and keep whichever helps.
      ;({ key, distance } = await probeBestDirection(page, { maximize }))
    }
  }
  return distance
}

const moveUntilWithin = (page, targetDistance) =>
  walk(page, { target: targetDistance, maximize: false })

const moveUntilAway = (page, targetDistance) =>
  walk(page, { target: targetDistance, maximize: true })

test.describe.configure({ mode: 'serial', timeout: 180_000 })

// This spec needs Chromium's fake media device and auto-granted permission, which
// only the chromium-desktop-fake-media project configures. In the other projects
// it skips rather than pretending a microphone is available.
test.beforeEach(async ({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-fake-media',
    'requires the chromium-desktop-fake-media project',
  )
})

const SIGNALING_ERROR = /WebRTC: failed|Uncaught|TypeError|ReferenceError/

function diagnostics(page) {
  return page.evaluate(() => window.__proxispeakWebrtc?.getPeerDiagnostics?.() ?? null)
}

async function enterOffice(page, email) {
  // A real account per browser context; 2D floor keeps the media assertions on
  // deterministic DOM coordinates while the WebRTC stack is unchanged.
  await signInAndEnterOffice(page, { email })
  // The diagnostics hook is installed by the WebRTC init effect once the socket
  // is connected, so waiting for it is a precise readiness signal.
  await expect
    .poll(async () => Boolean(await page.evaluate(() => window.__proxispeakWebrtc)), { timeout: 20_000 })
    .toBe(true)
}

// The mic controls exist twice in the DOM (desktop panel + mobile control bar),
// so every mic selector uses .first() to stay unambiguous.
async function enableMic(page) {
  const button = page.locator('button[aria-label="Enable microphone"]').first()
  await button.waitFor({ state: 'visible', timeout: 10_000 })
  await button.click()
  // The button flips once getUserMedia resolves and the meter starts.
  await page.locator('button[aria-label="Disable microphone"]').first().waitFor({ state: 'visible', timeout: 15_000 })
}

async function waitForConnected(page, label) {
  await expect
    .poll(async () => {
      const diag = await diagnostics(page)
      if (!diag || diag.peers.length !== 1) return `peers=${diag ? diag.peers.length : 'none'}`
      const [peer] = diag.peers
      if (peer.connectionState !== 'connected') return peer.connectionState
      if (!peer.audioGraph) return 'no-audio-graph'
      if (peer.remoteAudioTracks.length < 1) return 'no-remote-track'
      return 'connected'
    }, { timeout: 45_000, message: `${label}: expected 1 connected peer with remote audio` })
    .toBe('connected')
}

async function gainFor(page, remoteId) {
  const diag = await diagnostics(page)
  const peer = diag?.peers.find(p => p.remoteId === remoteId)
  return peer ? peer.gain : null
}

test('two browser peers complete the full WebRTC lifecycle', async ({ browser }) => {
  const consoleErrors = []
  const signalingErrors = []

  const trackConsole = (page, label) => {
    page.on('console', msg => {
      const text = msg.text()
      if (msg.type() === 'error') consoleErrors.push(`${label}: ${text}`)
      if (SIGNALING_ERROR.test(text)) signalingErrors.push(`${label}: ${text}`)
    })
    page.on('pageerror', error => consoleErrors.push(`${label}: pageerror ${error.message}`))
  }

  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()
  trackConsole(pageA, 'A')
  trackConsole(pageB, 'B')

  let contextC = null

  try {
    // 1. Both participants connect and join the same office.
    await enterOffice(pageA, 'webrtc-test-a@example.com')
    await enterOffice(pageB, 'webrtc-test-b@example.com')
    await expect(pageA.locator('body')).toContainText('Real-time with 1 remote', { timeout: 20_000 })
    await expect(pageB.locator('body')).toContainText('Real-time with 1 remote', { timeout: 20_000 })

    const idA = (await diagnostics(pageA)).localSocketId
    const idB = (await diagnostics(pageB)).localSocketId
    expect(idA).toBeTruthy()
    expect(idB).toBeTruthy()
    expect(idA).not.toBe(idB)

    // 2. Both enable their microphones (fake device, auto-granted).
    await enableMic(pageA)
    await enableMic(pageB)

    // 3-6. Offer, answer, ICE, connected on both sides. Each side must end with
    // exactly ONE peer connection: a second one would mean glare produced a
    // duplicate instead of being resolved.
    await waitForConnected(pageA, 'A')
    await waitForConnected(pageB, 'B')

    const diagA = await diagnostics(pageA)
    const diagB = await diagnostics(pageB)
    expect(diagA.micActive).toBe(true)
    expect(diagB.micActive).toBe(true)
    expect(diagA.peers[0].remoteId).toBe(idB)
    expect(diagB.peers[0].remoteId).toBe(idA)

    // 7. Remote audio track reached the receiving pipeline on both sides.
    expect(diagA.peers[0].remoteAudioTracks.length).toBeGreaterThanOrEqual(1)
    expect(diagB.peers[0].remoteAudioTracks.length).toBeGreaterThanOrEqual(1)
    expect(diagA.peers[0].audioGraph).toBe(true)
    expect(diagB.peers[0].audioGraph).toBe(true)

    // Both peers should be sending: the local mic track must be live.
    const senderCount = await pageA.evaluate(() => {
      // Read-only check: the diagnostics expose the local mic state, which is
      // driven by the real track the browser created.
      return window.__proxispeakWebrtc.getPeerDiagnostics().micActive
    })
    expect(senderCount).toBe(true)

    // 8. Proximity changes the remote peer's gain, using real pixel distance.
    await pageA.locator(REMOTE_AVATAR).first().waitFor({ state: 'visible', timeout: 10_000 })

    // Start by walking A well outside the 100px earshot. A distant peer must be
    // silent, not accidentally left at full volume. The direction probe can walk
    // the avatar into a corner, so retry once from the reset position before
    // treating a short distance as a product failure.
    let farDistance = await moveUntilAway(pageA, 200)
    if (farDistance <= 105) {
      await pageA.getByRole('button', { name: 'Reset avatar positions' }).click()
      await pageA.waitForTimeout(400)
      farDistance = await moveUntilAway(pageA, 200)
    }
    expect(farDistance).toBeGreaterThan(105)
    await expect
      .poll(async () => gainFor(pageB, idA), { timeout: 10_000, message: 'gain should be 0 outside earshot' })
      .toBeLessThan(0.05)
    expect((await avatarGap(pageB)).distance).toBeGreaterThan(100)

    // Now walk back toward B. The gain must rise and match the curve for the
    // distance B actually observes (B computes it from the synced positions).
    await moveUntilWithin(pageA, 55)
    await expect
      .poll(async () => gainFor(pageB, idA), { timeout: 10_000, message: 'gain should rise when the avatars get closer' })
      .toBeGreaterThan(0.05)

    const gapNear = await avatarGap(pageB)
    const gainNear = await gainFor(pageB, idA)
    expect(gapNear.distance).toBeLessThan(farDistance)
    const expectedNear = gapNear.distance >= 100 ? 0 : 0.1 + 0.9 * (1 - gapNear.distance / 100)
    expect(Math.abs(gainNear - expectedNear)).toBeLessThan(0.1)

    // 9a. Mute is a local track state: A reports not-mic-active, and B's gain
    // node is untouched by it.
    await pageA.locator('button[aria-label="Mute microphone"]').first().click()
    await expect
      .poll(async () => (await diagnostics(pageA)).micActive, { timeout: 5_000 })
      .toBe(false)
    expect(Math.abs((await gainFor(pageB, idA)) - gainNear)).toBeLessThan(0.15)
    await pageA.locator('button[aria-label="Unmute microphone"]').first().click()

    // 9b. Leaving/disconnecting removes the peer and its audio graph on the
    // other side; no stale remote audio keeps playing.
    await contextA.close()
    await expect
      .poll(async () => {
        const diag = await diagnostics(pageB)
        return diag ? diag.peers.length : -1
      }, { timeout: 15_000, message: 'peer must be cleaned up when A disconnects' })
      .toBe(0)

    // 9c. Reconnect: a new session joins, negotiates and receives audio again.
    contextC = await browser.newContext()
    const pageC = await contextC.newPage()
    trackConsole(pageC, 'C')
    await enterOffice(pageC, 'webrtc-test-c@example.com')
    await expect(pageC.locator('body')).toContainText('Real-time with 1 remote', { timeout: 20_000 })
    const idC = (await diagnostics(pageC)).localSocketId
    expect(idC).not.toBe(idA)

    await enableMic(pageC)
    await waitForConnected(pageC, 'C')
    await expect
      .poll(async () => {
        const diag = await diagnostics(pageB)
        return diag ? diag.peers.length : -1
      }, { timeout: 30_000, message: 'B should hold exactly one peer after C reconnects' })
      .toBe(1)

    await expect
      .poll(async () => {
        const diag = await diagnostics(pageB)
        return diag?.peers[0]?.remoteId ?? null
      }, { timeout: 10_000 })
      .toBe(idC)

    // 9d. Unmounting the office tears down the diagnostics hook and peers.
    await pageC.click(SELECTORS.backButton)
    await expect
      .poll(async () => pageC.evaluate(() => Boolean(window.__proxispeakWebrtc)), { timeout: 10_000 })
      .toBe(false)
    await expect
      .poll(async () => {
        const diag = await diagnostics(pageB)
        return diag ? diag.peers.length : -1
      }, { timeout: 15_000 })
      .toBe(0)

    // 9e. Remount: re-entering the office on the same page installs the hook
    // again and negotiates a fresh connection with B (no state survives unmount).
    await pageC.click(SELECTORS.enterOfficeButton)
    await waitForOfficeReady(pageC)
    await expect
      .poll(async () => pageC.evaluate(() => Boolean(window.__proxispeakWebrtc)), { timeout: 20_000 })
      .toBe(true)
    await enableMic(pageC)
    await waitForConnected(pageC, 'C-remount')
    await expect
      .poll(async () => {
        const diag = await diagnostics(pageB)
        return diag ? diag.peers.length : -1
      }, { timeout: 25_000, message: 'B should hold exactly one peer after the remount' })
      .toBe(1)

    // No uncaught errors or failed signaling anywhere in the run.
    expect(signalingErrors, `signaling errors:\n${signalingErrors.join('\n')}`).toEqual([])
    expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toEqual([])
  } finally {
    await contextA.close().catch(() => {})
    await contextB.close().catch(() => {})
    if (contextC) await contextC.close().catch(() => {})
  }
})

test('the stable avatar position is unchanged by audio failures', async ({ browser }) => {
  // A peer that fails to negotiate must not break movement or presence sync.
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await enterOffice(page)
    const before = await getAvatarCenter(page)

    // Deny the microphone so no audio path can be established at all.
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'))
    })
    await page.locator('button[aria-label="Enable microphone"]').first().click()
    await expect(page.locator('text=Microphone access failed')).toBeVisible({ timeout: 10_000 })

    // Movement still works, and no peer connection was created.
    await page.keyboard.down('d')
    await page.waitForTimeout(400)
    await page.keyboard.up('d')
    const after = await getAvatarCenter(page)
    expect(after.x).toBeGreaterThan(before.x + 3)

    const diag = await diagnostics(page)
    expect(diag.peers.length).toBe(0)
  } finally {
    await context.close()
  }
})
