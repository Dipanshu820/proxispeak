// WebRTC reliability tests (Chromium fake media device).
//
// These complement webrtc-peer.spec.js with the failure/recovery paths:
//   1. repeated microphone enable/disable cycles,
//   2. a socket interruption followed by reconnection and renegotiation,
//   3. three peers with independent proximity gain.
//
// Like the lifecycle spec, this does NOT prove audibility: Chromium's fake device
// emits silence. It proves the media path, signaling, cleanup, and gain wiring.
import { test, expect } from '@playwright/test'
import { SELECTORS, signInAndEnterOffice, waitForOfficeReady } from './helpers.js'

test.describe.configure({ mode: 'serial', timeout: 240_000 })

test.beforeEach(async ({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-fake-media',
    'requires the chromium-desktop-fake-media project',
  )
})

function diagnostics(page) {
  return page.evaluate(() => window.__proxispeakWebrtc?.getPeerDiagnostics?.() ?? null)
}

async function enterOffice(page, email) {
  await signInAndEnterOffice(page, { email })
  await expect
    .poll(async () => Boolean(await page.evaluate(() => window.__proxispeakWebrtc)), { timeout: 20_000 })
    .toBe(true)
}

async function enableMic(page) {
  await page.locator('button[aria-label="Enable microphone"]').first().click()
  await page
    .locator('button[aria-label="Disable microphone"]')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
}

async function disableMic(page) {
  await page.locator('button[aria-label="Disable microphone"]').first().click()
  await page
    .locator('button[aria-label="Enable microphone"]')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
}

// Receiver `track.muted` is intentionally NOT a success criterion here. Chromium's
// fake audio device produces digital silence, and the muted flag tracks audible
// audio energy, so it can stay true even while RTP is flowing. The reliable media
// signal is the inbound-rtp packet counter from getStats().
async function waitForPeerState(page, expectedPeers, timeout = 45_000) {
  await expect
    .poll(
      async () => {
        const diag = await diagnostics(page)
        if (!diag || diag.peers.length !== expectedPeers) return `peers=${diag ? diag.peers.length : 'none'}`
        if (diag.peers.some(peer => peer.connectionState !== 'connected')) return 'connecting'
        if (diag.peers.some(peer => !peer.audioGraph)) return 'no-audio-graph'
        if (diag.peers.some(peer => peer.remoteAudioTracks.length < 1)) return 'no-remote-track'
        if (diag.peers.some(peer => peer.localAudioSenders !== 1)) return 'sender-count'
        return 'ready'
      },
      { timeout, message: `expected ${expectedPeers} fully connected peer(s)` },
    )
    .toBe('ready')
}

async function inboundPackets(page) {
  const stats = await page.evaluate(() => window.__proxispeakWebrtc?.getPeerStats?.() ?? [])
  return stats.reduce((sum, entry) => sum + (entry.inboundAudioPackets || 0), 0)
}

async function outboundPackets(page) {
  const stats = await page.evaluate(() => window.__proxispeakWebrtc?.getPeerStats?.() ?? [])
  return stats.reduce((sum, entry) => sum + (entry.outboundAudioPackets || 0), 0)
}

// Prove media is actually moving in both directions, not just that ICE settled.
async function expectBidirectionalMedia(a, b) {
  await expect.poll(async () => inboundPackets(a), { timeout: 20_000 }).toBeGreaterThan(0)
  await expect.poll(async () => inboundPackets(b), { timeout: 20_000 }).toBeGreaterThan(0)

  const [aIn, bIn, aOut, bOut] = await Promise.all([
    inboundPackets(a),
    inboundPackets(b),
    outboundPackets(a),
    outboundPackets(b),
  ])
  await a.waitForTimeout(500)
  expect(await inboundPackets(a)).toBeGreaterThan(aIn)
  expect(await inboundPackets(b)).toBeGreaterThan(bIn)
  expect(await outboundPackets(a)).toBeGreaterThan(aOut)
  expect(await outboundPackets(b)).toBeGreaterThan(bOut)
}

test('repeated microphone enable/disable cycles keep exactly one live sender', async ({ browser }) => {
  const errors = []
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()
  for (const [label, page] of [['A', pageA], ['B', pageB]]) {
    page.on('pageerror', error => errors.push(`${label}: ${error.message}`))
  }

  try {
    await enterOffice(pageA, 'reliability-test-a@example.com')
    await enterOffice(pageB, 'reliability-test-b@example.com')
    await enableMic(pageA)
    await enableMic(pageB)
    await waitForPeerState(pageA, 1)
    await waitForPeerState(pageB, 1)

    const peerBefore = (await diagnostics(pageA)).peers[0].remoteId

    for (let cycle = 0; cycle < 2; cycle += 1) {
      await disableMic(pageA)
      await enableMic(pageA)
    }

    // The connection is reused, not replaced: same remote peer, exactly one peer
    // connection, one audio sender, and a live remote track on B.
    await expect
      .poll(
        async () => {
          const diag = await diagnostics(pageA)
          if (!diag) return 'no-diagnostics'
          if (!diag.micActive) return 'mic-inactive'
          if (diag.peers.length !== 1) return `peers=${diag.peers.length}`
          const [peer] = diag.peers
          if (peer.remoteId !== peerBefore) return 'peer-replaced'
          if (peer.connectionState !== 'connected') return peer.connectionState
          if (peer.localAudioSenders !== 1) return `senders=${peer.localAudioSenders}`
          return 'ok'
        },
        { timeout: 30_000, message: 'mic cycles should reuse one peer and one audio sender' },
      )
      .toBe('ok')

    // Media must still reach B after the cycles. Packet counters are the evidence;
    // see the note above about track.muted and the fake device's silence.
    await expectBidirectionalMedia(pageA, pageB)

    expect(errors, errors.join('\n')).toEqual([])
  } finally {
    await contextA.close().catch(() => {})
    await contextB.close().catch(() => {})
  }
})

test('a socket interruption reconnects and renegotiates audio', async ({ browser }) => {
  const errors = []
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()
  for (const [label, page] of [['A', pageA], ['B', pageB]]) {
    page.on('pageerror', error => errors.push(`${label}: ${error.message}`))
  }

  try {
    await enterOffice(pageA, 'reconnect-test-a@example.com')
    await enterOffice(pageB, 'reconnect-test-b@example.com')
    await enableMic(pageA)
    await enableMic(pageB)
    await waitForPeerState(pageA, 1)
    await waitForPeerState(pageB, 1)

    const oldIdA = (await diagnostics(pageA)).localSocketId
    const oldIdB = (await diagnostics(pageB)).localSocketId
    expect(oldIdA).not.toBe(oldIdB)

    // Sever B's transport. Socket.io reconnects, re-presents the same signed
    // session, re-joins the room, and the peers renegotiate from scratch.
    await pageB.evaluate(() => window.__proxispeakSession.interruptConnection())

    // Wait for a *new, usable* socket id. While the transport is down the
    // diagnostics hook is intentionally removed, so `null` is not reconnection.
    await expect
      .poll(
        async () => {
          const diag = await diagnostics(pageB)
          return diag?.localSocketId && diag.localSocketId !== oldIdB ? 'reconnected' : 'waiting'
        },
        { timeout: 30_000, message: 'socket.io should reconnect with a new socket id' },
      )
      .toBe('reconnected')

    const newIdB = (await diagnostics(pageB)).localSocketId
    expect(newIdB).toBeTruthy()
    expect(newIdB).not.toBe(oldIdB)

    await waitForPeerState(pageB, 1, 60_000)
    await expect
      .poll(async () => (await diagnostics(pageB))?.peers[0]?.remoteId ?? null, { timeout: 30_000 })
      .toBe(oldIdA)

    await waitForPeerState(pageA, 1, 60_000)
    await expect
      .poll(async () => (await diagnostics(pageA))?.peers[0]?.remoteId ?? null, { timeout: 30_000 })
      .toBe(newIdB)

    // The reconnect must restore media in BOTH directions, not merely a
    // connected ICE pair. Inbound/outbound audio packet counters keep rising.
    const diagA = await diagnostics(pageA)
    expect(diagA.peers[0].audioGraph).toBe(true)
    await expectBidirectionalMedia(pageA, pageB)

    expect(errors, errors.join('\n')).toEqual([])
  } finally {
    await contextA.close().catch(() => {})
    await contextB.close().catch(() => {})
  }
})

test('three peers keep independent proximity gain', async ({ browser }) => {
  const errors = []
  const contexts = []
  const pages = []
  try {
    for (let i = 0; i < 3; i += 1) {
      const context = await browser.newContext()
      contexts.push(context)
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(`page${i + 1}: ${error.message}`))
      pages.push(page)
    }
    const [a, b, c] = pages
    await enterOffice(a, 'proximity-test-a@example.com')
    await enterOffice(b, 'proximity-test-b@example.com')
    await enterOffice(c, 'proximity-test-c@example.com')
    for (const page of pages) await enableMic(page)
    for (const page of pages) await waitForPeerState(page, 2, 60_000)

    const ids = {}
    for (let i = 0; i < 3; i += 1) ids[i] = (await diagnostics(pages[i])).localSocketId
    expect(new Set(Object.values(ids)).size).toBe(3)

    const gainOn = async (page, remoteId) => {
      const diag = await diagnostics(page)
      const peer = diag?.peers.find(p => p.remoteId === remoteId)
      return peer ? peer.gain : null
    }

    // Move A away from the other two. Every peer has its own gain node, so B must
    // silence A while keeping C audible at the same moment.
    //
    // Hold a direction while polling the gain instead of nudging once and reading
    // immediately: position sync is throttled (~10/s), so a single 1.2 s tap can
    // leave the reported gain behind the actual distance. Keep walking until the
    // gain is exactly 0, then a little further so the remote jitter interval cannot
    // pull the peers back inside the earshot between assertions.
    const directions = ['a', 'w', 'd', 's']
    let quiet = false
    for (const key of directions) {
      await a.keyboard.down(key)
      const start = Date.now()
      while (Date.now() - start < 3000) {
        await a.waitForTimeout(250)
        const gainToA = await gainOn(b, ids[0])
        if (gainToA === 0) {
          quiet = true
          break
        }
      }
      if (quiet) {
        await a.waitForTimeout(500)
        await a.keyboard.up(key)
        break
      }
      await a.keyboard.up(key)
    }
    expect(quiet, 'A should move outside the 100px earshot').toBe(true)

    const gainBA = await gainOn(b, ids[0])
    const gainBC = await gainOn(b, ids[2])
    expect(gainBA).toBeLessThan(0.05)
    expect(gainBC).toBeGreaterThan(0.5)

    // The other side of the same pair agrees, and C still has both peers.
    const gainAB = await gainOn(a, ids[1])
    expect(gainAB).toBeLessThan(0.05)
    expect((await diagnostics(c)).peers).toHaveLength(2)

    expect(errors, errors.join('\n')).toEqual([])
  } finally {
    for (const context of contexts) await context.close().catch(() => {})
  }
})
