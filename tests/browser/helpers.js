// Browser test helpers for ProxiSpeak virtual office.
// Uses stable selectors: aria-labels, data attributes, and element IDs that the
// production code already exposes for a11y. Only adds data-testid where no stable
// selector exists, and keeps those minimal.

export const SELECTORS = {
  enterOfficeButton: '[data-testid="enter-office"]',
  backButton: '[aria-label="Back to landing page"]',
  floor: '.office-floor',
  // Avatar whose accessible name starts with the given name, e.g. "You,"
  avatar: (name = 'You') => `.office-floor [aria-label^="${name},"]`,
  earshotCircle: '.earshot-circle',
  micButton: (state) => `button[aria-label="${state === 'on' ? 'Disable microphone' : 'Enable microphone'}"]`,
  muteButton: 'button[aria-label="Mute microphone"]',
  unmuteButton: 'button[aria-label="Unmute microphone"]',
  volumeSlider: '#output-volume',
  colleaguesPanel: '#colleagues',
  nearbyStat: '[data-testid="stat-nearby"]',
  micStatus: '[data-testid="mic-status"]',
  distanceDisplay: '[data-testid="distance-display"]',
  enableMicToast: 'text=Microphone enabled locally',
  disableMicToast: 'text=Microphone disabled',
  // Furniture items - query by data attribute
  furniture: (id) => `[data-furniture-id="${id}"]`,
  // Rooms
  room: (id) => `[data-room-id="${id}"]`,
  // Toast notifications
  toast: '[role="status"]',
  // Mobile controls
  mobileControls: '.mobile-controls-panel',
  resetButton: 'button[aria-label="Reset avatar positions"]',
  saveButton: 'button[aria-label="Save layout"]',
}

// Create a real account through the public API and open the office.
//
// Every browser context gets its own account (the office requires a signed-in
// session). The display name defaults to "You" because the legacy floor specs
// address the local avatar by that name. `renderer: '2d'` requests the
// accessible DOM floor explicitly through the supported `?renderer=2d`
// override, so those specs test the fallback deterministically while the
// dedicated 3D spec covers the rendered scene.
//
// To avoid hitting the signup rate limiter during test runs, this function
// first attempts to login with the test account. If that fails, it tries to
// create the account via signup. If signup fails with EMAIL_TAKEN (race
// condition from parallel tests), it retries login. This approach still
// exercises real authentication and session validation while being
// rate-limiter friendly.
//
// For multi-user tests, pass a unique `email` to create separate accounts.
export async function signInAndEnterOffice(page, { name = 'You', email = null, renderer = '2d' } = {}) {
  const testPassword = 'correct-horse-1'
  const testEmail = email || 'browser-test@example.com'

  // First try to login with the test account
  let response = await page.request.post('/api/auth/login', {
    data: {
      email: testEmail,
      password: testPassword,
    },
  })

  // If login fails (account doesn't exist), try to create it via signup
  if (!response.ok()) {
    response = await page.request.post('/api/auth/signup', {
      data: {
        name,
        email: testEmail,
        password: testPassword,
        confirmPassword: testPassword,
      },
    })

    // If signup fails with EMAIL_TAKEN (race condition), retry login
    if (!response.ok()) {
      const body = await response.text()
      if (body.includes('EMAIL_TAKEN')) {
        response = await page.request.post('/api/auth/login', {
          data: {
            email: testEmail,
            password: testPassword,
          },
        })
      }
    }
  }

  if (!response.ok()) {
    throw new Error(`browser auth failed: ${response.status()} ${await response.text()}`)
  }

  await page.goto(renderer === '2d' ? '/office?renderer=2d' : '/office')
  if (renderer === '2d') await waitForOfficeReady(page, 20_000)
  return response
}

// Wait for the office floor to be visible and measured (has non-zero size).
export async function waitForOfficeReady(page, timeout = 10_000) {
  const floor = page.locator(SELECTORS.floor)
  await floor.waitFor({ state: 'visible', timeout })
  // Wait for the floor to have been measured - it should have non-zero dimensions
  const box = await floor.boundingBox()
  if (!box || box.width === 0 || box.height === 0) {
    throw new Error(`Office floor has zero dimensions: ${JSON.stringify(box)}`)
  }
  return box
}

// Wait for avatar to be present and get its position.
export async function getAvatarPosition(page, name = 'You') {
  const avatar = page.locator(SELECTORS.avatar(name))
  await avatar.waitFor({ state: 'visible' })
  const box = await avatar.boundingBox()
  if (!box) throw new Error(`Avatar "${name}" not visible`)
  const floorBox = await page.locator(SELECTORS.floor).boundingBox()
  if (!floorBox) throw new Error('Floor not visible')
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    floorWidth: floorBox.width,
    floorHeight: floorBox.height,
  }
}

// Wait until the 3D scene reports that it is mounted (browser-test hook).
export async function waitForScene3D(page, timeout = 30_000) {
  await page.locator('[data-testid="office-scene-3d"] canvas').waitFor({ state: 'visible', timeout })
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const ready = await page.evaluate(() => Boolean(window.__proxispeakScene?.ready))
    if (ready) return
    await page.waitForTimeout(100)
  }
  throw new Error('3D scene did not become ready')
}

// Get avatar center position relative to floor.
export async function getAvatarCenter(page, name = 'You') {
  const pos = await getAvatarPosition(page, name)
  return {
    x: pos.x + pos.width / 2,
    y: pos.y + pos.height / 2,
    floorWidth: pos.floorWidth,
    floorHeight: pos.floorHeight,
  }
}

// Convert pixel position to floor percentage.
export function pxToPct(px, py, floorWidth, floorHeight) {
  return {
    x: (px / floorWidth) * 100,
    y: (py / floorHeight) * 100,
  }
}

// Get furniture bounding box relative to floor.
export async function getFurnitureRect(page, furnitureId) {
  const el = page.locator(SELECTORS.furniture(furnitureId))
  await el.waitFor({ state: 'visible' })
  const box = await el.boundingBox()
  const floorBox = await page.locator(SELECTORS.floor).boundingBox()
  if (!box || !floorBox) throw new Error(`Furniture ${furnitureId} or floor not visible`)
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    floorWidth: floorBox.width,
    floorHeight: floorBox.height,
  }
}

// Check if avatar overlaps with furniture (using bounding boxes).
export async function avatarOverlapsFurniture(page, avatarName = 'You', furnitureId) {
  const avatar = await getAvatarPosition(page, avatarName)
  const furniture = await getFurnitureRect(page, furnitureId)
  
  const avatarLeft = avatar.x
  const avatarRight = avatar.x + avatar.width
  const avatarTop = avatar.y
  const avatarBottom = avatar.y + avatar.height
  
  const furnLeft = furniture.x
  const furnRight = furniture.x + furniture.width
  const furnTop = furniture.y
  const furnBottom = furniture.y + furniture.height
  
  // AABB overlap test
  return !(avatarRight < furnLeft || avatarLeft > furnRight || 
           avatarBottom < furnTop || avatarTop > furnBottom)
}

// Perform keyboard movement by pressing and holding a key, then waiting for movement.
export async function moveWithKeys(page, key, holdMs = 300) {
  await page.keyboard.down(key)
  await page.waitForTimeout(holdMs)
  await page.keyboard.up(key)
}

// Perform drag using Playwright's mouse API.
// The avatar component listens for onPointerDown (to set pointer capture) and
// has onPointerMove on the avatar element itself (after pointer capture is set).
// Playwright's mouse API dispatches native mouse events which trigger pointer events
// in modern browsers.
//
// IMPORTANT: The avatar must be scrolled into view before dragging, because
// page.mouse moves in viewport coordinates and pointer events won't fire
// reliably on elements outside the visible viewport.
// Perform drag using Playwright's mouse API.
// The avatar component listens for onPointerDown (to set pointer capture) and
// has onPointerMove on the avatar element itself (after pointer capture is set).
// Playwright's mouse API dispatches native mouse events which trigger pointer events
// in modern browsers.
//
// IMPORTANT: The avatar must be scrolled into view before dragging, because
// page.mouse coordinates are viewport-relative and pointer events don't fire
// reliably on elements outside the visible viewport.
//
// targetX/targetY are absolute page coordinates (from boundingBox). After
// scrolling the avatar into view, we recompute all positions relative to the
// viewport to ensure correct mouse positioning.
export async function dragAvatar(page, targetX, targetY, avatarName = 'You') {
  const avatar = page.locator(SELECTORS.avatar(avatarName))
  await avatar.waitFor({ state: 'visible' })
  
  // Get page scroll position before scrolling
  const scrollBefore = await page.evaluate(() => ({
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  }))
  
  // Record avatar and target positions in page coordinates
  const avatarBoxBefore = await avatar.boundingBox()
  if (!avatarBoxBefore) throw new Error('Avatar not visible for drag')
  
  // Compute target position in viewport coordinates (before scroll)
  const targetViewportX = targetX - scrollBefore.scrollX
  const targetViewportY = targetY - scrollBefore.scrollY
  
  // Compute avatar center in viewport coordinates (before scroll)
  const avatarCenterXBefore = avatarBoxBefore.x + avatarBoxBefore.width / 2 - scrollBefore.scrollX
  const avatarCenterYBefore = avatarBoxBefore.y + avatarBoxBefore.height / 2 - scrollBefore.scrollY
  
  // Scroll avatar into view
  await avatar.scrollIntoViewIfNeeded()
  await page.waitForTimeout(100)
  
  // Get new scroll position after scrolling
  const scrollAfter = await page.evaluate(() => ({
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  }))
  
  // Re-measure avatar position after scrolling (page coordinates)
  const avatarBox = await avatar.boundingBox()
  if (!avatarBox) throw new Error('Avatar not visible for drag after scroll')
  
  // Compute avatar center in viewport coordinates after scroll
  const avatarCenterX = avatarBox.x + avatarBox.width / 2 - scrollAfter.scrollX
  const avatarCenterY = avatarBox.y + avatarBox.height / 2 - scrollAfter.scrollY
  
  // Compute new target in viewport coordinates
  // The drag delta in viewport space should be preserved
  const deltaViewportX = targetViewportX - avatarCenterXBefore
  const deltaViewportY = targetViewportY - avatarCenterYBefore
  const newTargetViewportX = avatarCenterX + deltaViewportX
  const newTargetViewportY = avatarCenterY + deltaViewportY
  
  // Move to avatar center (viewport coordinates) and press down
  await page.mouse.move(avatarCenterX, avatarCenterY)
  await page.mouse.down()
  
  // Wait for React to process the pointerdown and set dragging state
  await page.waitForTimeout(100)
  
  // Move to target position (viewport coordinates)
  await page.mouse.move(newTargetViewportX, newTargetViewportY, { steps: 10 })
  
  // Release
  await page.mouse.up()
  
  // Wait for movement to settle
  await page.waitForTimeout(300)
}

// Get text content from a colleague list entry by name.
export async function getColleagueInfo(page, name) {
  const colleagues = page.locator(SELECTORS.colleaguesPanel)
  await colleagues.waitFor({ state: 'visible' })
  
  const entries = colleagues.locator('[aria-label]')
  const count = await entries.count()
  
  for (let i = 0; i < count; i++) {
    const ariaLabel = await entries.nth(i).getAttribute('aria-label')
    if (ariaLabel && ariaLabel.startsWith(name)) {
      return {
        ariaLabel,
        element: entries.nth(i),
      }
    }
  }
  return null
}

// Get the distance text for a colleague (e.g., "150px").
export async function getColleagueDistance(page, name) {
  const info = await getColleagueInfo(page, name)
  if (!info) return null
  
  // Look for distance text in the element or its siblings
  const text = await info.element.textContent()
  const match = text.match(/(\d+)px/)
  return match ? parseInt(match[1], 10) : null
}

// Check if proximity bar is visible for a colleague.
export async function colleagueHasProximityBar(page, name) {
  const info = await getColleagueInfo(page, name)
  if (!info) return false
  
  // Find proximity bar within the same list item
  const listItem = info.element.locator('xpath=ancestor::*[@aria-label]')
  const bar = listItem.locator('.proximity-bar')
  return bar.isVisible()
}

// Wait for a toast message to appear and return its text.
export async function getToastText(page, timeout = 5_000) {
  const toast = page.locator(SELECTORS.toast)
  await toast.waitFor({ state: 'visible', timeout })
  return toast.textContent()
}

// Clear any visible toast by waiting for it to disappear.
export async function waitForToastDisappear(page, timeout = 3_000) {
  const toast = page.locator(SELECTORS.toast)
  try {
    await toast.waitFor({ state: 'hidden', timeout })
  } catch {
    // Toast might still be visible, that's ok for some tests
  }
}
