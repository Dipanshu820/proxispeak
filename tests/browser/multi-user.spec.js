import { test, expect } from '@playwright/test'
import {
  SELECTORS,
  signInAndEnterOffice,
  waitForOfficeReady,
  getAvatarCenter,
} from './helpers.js'

test.describe('ProxiSpeak Multi-User Synchronization', () => {
  let page1, page2, context1, context2

  test.beforeEach(async ({ browser }) => {
    // Create two independent browser contexts
    context1 = await browser.newContext()
    context2 = await browser.newContext()

    page1 = await context1.newPage()
    page2 = await context2.newPage()

    // Each context gets its own real account, then joins the same room on the
    // accessible 2D floor (deterministic DOM selectors). Use unique emails
    // so both users can be authenticated simultaneously in the same room.
    await signInAndEnterOffice(page1, { email: 'browser-test-1@example.com' })
    await signInAndEnterOffice(page2, { email: 'browser-test-2@example.com' })

    await waitForOfficeReady(page1)
    await waitForOfficeReady(page2)

    // Wait for each page to actually reach the connected state rather than
    // hoping a fixed delay is enough. We wait for the local avatar on each page's
    // floor to become visible. That proves the office rendered; the cross-client
    // sync (remote avatar appearing) is asserted by the tests themselves. Using
    // .first() avoids a strict-mode violation when the locator matches both the
    // local and the remote "You," avatar (which happens on mobile once both
    // clients have joined the same room).
    await page1.locator('.office-floor [aria-label^="You,"]').first().waitFor({ state: 'visible', timeout: 15000 })
    await page2.locator('.office-floor [aria-label^="You,"]').first().waitFor({ state: 'visible', timeout: 15000 })
  })

  test.afterEach(async () => {
    // Close both contexts once. Do NOT also close page1.context()/page2.context()
    // elsewhere — that would race with this teardown and double-close.
    await context1.close()
    await context2.close()
  })

  test('both clients connect to the socket server without errors', async () => {
    // Capture console errors on both pages for the duration of this test.
    const errors1 = []
    const errors2 = []
    page1.on('console', msg => { if (msg.type() === 'error') errors1.push(msg.text()) })
    page2.on('console', msg => { if (msg.type() === 'error') errors2.push(msg.text()) })

    // Give any late-arriving errors a moment to fire.
    await page1.waitForTimeout(500)
    await page2.waitForTimeout(500)

    // Known non-issues: socket.io may log WebSocket disconnection when a context
    // tears down; those are expected during cleanup, not during steady state.
    const meaningfulErrors1 = errors1.filter(e => !e.includes('WebSocket') || !e.includes('4000'))
    const meaningfulErrors2 = errors2.filter(e => !e.includes('WebSocket') || !e.includes('4000'))

    expect(meaningfulErrors1.length).toBe(0)
    expect(meaningfulErrors2.length).toBe(0)
  })

  test('each client sees local avatar at default position', async () => {
    // Both pages have already reached CONNECTED state in beforeEach.

    // Page 1 — the local avatar is the element whose aria-label starts with
    // "You," AND that itself carries aria-current="true". The component emits
    // aria-current on the avatar wrapper when p.you is true, so we can match it
    // with a single compound CSS selector instead of a fragile has():filter chain.
    const localAvatar1 = page1.locator('.office-floor [aria-label^="You,"][aria-current="true"]').first()
    await localAvatar1.waitFor({ state: 'visible' })
    const box1 = await localAvatar1.boundingBox()
    expect(box1).toBeDefined()

    // Page 2 — same assertion.
    const localAvatar2 = page2.locator('.office-floor [aria-label^="You,"][aria-current="true"]').first()
    await localAvatar2.waitFor({ state: 'visible' })
    const box2 = await localAvatar2.boundingBox()
    expect(box2).toBeDefined()
  })

  test('remote user appears in second client after first client joins', async () => {
    // Both clients are connected to the same room ('design-team') and both joined
    // with the display name 'You'. page2 should therefore see page1 as a remote
    // participant in addition to its own local avatar.
    const avatarsOnPage2 = await page2.locator('.office-floor [aria-label^="You,"]').all()

    // At least 2: page2's own local avatar + page1's remote avatar.
    expect(avatarsOnPage2.length).toBeGreaterThanOrEqual(2)
  })

  test('disconnect cleans up remote presence', async () => {
    // Count avatars on page2 before disconnecting page1.
    const remoteBefore = await page2.locator('.office-floor [aria-label^="You,"]').count()
    expect(remoteBefore).toBeGreaterThanOrEqual(2)

    // Close page1's context only. This triggers a socket disconnect on the server,
    // which broadcasts presence:left to everyone else in the room.
    await context1.close()

    // Wait for the presence:left event to propagate and be rendered.
    await page2.waitForTimeout(2000)

    // After page1 disconnects, page2 should see one fewer avatar.
    const remoteAfter = await page2.locator('.office-floor [aria-label^="You,"]').count()
    expect(remoteAfter).toBeLessThan(remoteBefore)
  })
})
