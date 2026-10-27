import { test, expect } from '@playwright/test'
import { signInAndEnterOffice, waitForScene3D } from './helpers.js'

// The legacy floor specs run against the accessible 2D renderer. This file is
// the proof that the default office is a real Three.js scene: it mounts WebGL,
// reports a live local position and moves that avatar with the keyboard.
test.describe('3D office (real WebGL)', () => {
  // WebGL context teardown can be slow on software-rendered CI machines.
  test.describe.configure({ timeout: 120_000 })

  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium-desktop',
      'WebGL scene is verified on desktop Chromium',
    )
  })

  test('renders a WebGL canvas, keeps the scene alive, and moves the avatar', async ({ page }) => {
    const errors = []
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })

    await signInAndEnterOffice(page, { renderer: '3d' })
    await waitForScene3D(page)

    const canvas = page.locator('[data-testid="office-scene-3d"] canvas')
    await expect(canvas).toBeVisible()

    const size = await canvas.boundingBox()
    expect(size.width).toBeGreaterThan(400)
    expect(size.height).toBeGreaterThan(300)

    // A context that exists and is not lost is the minimum evidence that this is
    // a rendered 3D scene rather than styled DOM.
    const context = await page.evaluate(() => {
      const element = document.querySelector('[data-testid="office-scene-3d"] canvas')
      const gl = element?.getContext('webgl2') || element?.getContext('webgl')
      return gl ? { lost: gl.isContextLost(), width: element.width, height: element.height } : null
    })
    expect(context).not.toBeNull()
    expect(context.lost).toBe(false)
    expect(context.width).toBeGreaterThan(0)

    const before = await page.evaluate(() => window.__proxispeakScene.getLocalPosition())
    expect(Number.isFinite(before.x)).toBe(true)
    expect(Number.isFinite(before.y)).toBe(true)

    await page.keyboard.down('d')
    await page.waitForTimeout(800)
    await page.keyboard.up('d')
    await page.waitForTimeout(250)

    const after = await page.evaluate(() => window.__proxispeakScene.getLocalPosition())
    expect(after.x).toBeGreaterThan(before.x + 0.25)
    expect(Math.abs(after.y - before.y)).toBeLessThan(0.5)

    // Holding a movement key must not have produced runtime errors.
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('serves the accessible 2D fallback when explicitly requested', async ({ page }) => {
    await signInAndEnterOffice(page, { renderer: '2d' })

    await expect(page.locator('.office-floor')).toBeVisible()
    await expect(page.locator('[data-testid="office-scene-3d"] canvas')).toHaveCount(0)
    await expect(page.locator('.office-floor [aria-label^="You,"]').first()).toBeVisible()
  })
})
