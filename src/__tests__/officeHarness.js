// Shared harness for driving the real VirtualOffice component in jsdom.
//
// jsdom has no layout engine, so `getBoundingClientRect()` always returns zeros
// and `requestAnimationFrame` fires on a real clock. Both would make the office
// floor untestable. This harness gives the floor a realistic size and makes
// animation frames deterministic so keyboard movement can be asserted over many
// frames.

import { act, render } from '@testing-library/react'
import { vi } from 'vitest'

// Render a component and let its post-mount async work settle inside act().
//
// VirtualOffice requests a session on mount. In unit tests the hermetic fetch
// stub rejects that request, and the resulting setState would otherwise land in
// a microtask after render() returns — outside act(), which React reports as a
// warning and which makes the settled component state order-dependent.
export async function renderSettled(ui) {
  const view = render(ui)
  await act(async () => {})
  return view
}

export const FLOOR_WIDTH = 900
export const FLOOR_HEIGHT = 540
export const FLOOR_OPTIONS = { floorWidth: FLOOR_WIDTH, floorHeight: FLOOR_HEIGHT }

// Snapshot of the original environment so the harness can fully restore it.
// This prevents global/prototype stubs from leaking across test files in the
// same vitest worker (which is what made the persistence test intermittently
// slow and time out).
const _originalRaf = globalThis.requestAnimationFrame
const _originalCaf = globalThis.cancelAnimationFrame
const _originalGetBoundingClientRect = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'getBoundingClientRect',
)
const _originalSetPointerCapture = Element.prototype.setPointerCapture
const _originalReleasePointerCapture = Element.prototype.releasePointerCapture

function restoreOriginalGetBoundingClientRect() {
  if (_originalGetBoundingClientRect) {
    Object.defineProperty(Element.prototype, 'getBoundingClientRect', _originalGetBoundingClientRect)
  } else {
    delete Element.prototype.getBoundingClientRect
  }
}

function restoreOriginalPointerCapture() {
  if (_originalSetPointerCapture) {
    Element.prototype.setPointerCapture = _originalSetPointerCapture
  } else {
    delete Element.prototype.setPointerCapture
  }
  if (_originalReleasePointerCapture) {
    Element.prototype.releasePointerCapture = _originalReleasePointerCapture
  } else {
    delete Element.prototype.releasePointerCapture
  }
}

export function installOfficeHarness() {
  let frames = []
  let clock = 1000

  // Stub rAF/caf so animation frames are deterministic and batched by the
  // test harness instead of firing on a real clock.
  vi.stubGlobal('requestAnimationFrame', (callback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})

  // jsdom returns zeros for getBoundingClientRect, which makes the floor
  // unmeasurable. Replace it with a representative desktop floor size.
  const rectDescriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    'getBoundingClientRect',
  )
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    value: () => ({
      width: FLOOR_WIDTH,
      height: FLOOR_HEIGHT,
      left: 0,
      top: 0,
      right: FLOOR_WIDTH,
      bottom: FLOOR_HEIGHT,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
    writable: true,
    configurable: true,
    enumerable: false,
  })

  // jsdom does not implement pointer capture; the drag handler calls it.
  const originalSetPointerCapture = Element.prototype.setPointerCapture
  const originalReleasePointerCapture = Element.prototype.releasePointerCapture
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}

  return {
    pumpFrames(count = 1, step = 20) {
      for (let i = 0; i < count; i += 1) {
        const queued = frames
        frames = []
        const timestamp = clock
        act(() => {
          for (const callback of queued) callback(timestamp)
        })
        clock += step
      }
      return clock
    },
    clearFrames() {
      frames = []
    },
    uninstall() {
      // Restore everything we changed, in reverse order of installation.
      // This runs even when a test failed, because afterEach always runs.
      vi.unstubAllGlobals()
      restoreOriginalGetBoundingClientRect()
      restoreOriginalPointerCapture()
      // Reset the rAF frame queue so a stale callback from a previous test
      // cannot fire during the next test's mount.
      frames = []
      clock = 1000
    },
  }
}

export function floorElement(container) {
  return container.querySelector('.office-floor')
}

// The avatar on the floor whose accessible name starts with `name`.
export function avatarElement(container, name = 'You') {
  return floorElement(container).querySelector(`[aria-label^="${name},"]`)
}

export function avatarPosition(container, name = 'You') {
  const element = avatarElement(container, name)
  return { x: parseFloat(element.style.left), y: parseFloat(element.style.top) }
}

export function keyDown(key, target = window) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

export function keyUp(key, target = window) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
  })
}

export function blurWindow() {
  act(() => {
    window.dispatchEvent(new Event('blur'))
  })
}

// jsdom has no PointerEvent; React dispatches by event type, so a MouseEvent
// carrying the pointer coordinates exercises the real handlers.
export function pointerEvent(target, type, { xPct, yPct } = {}) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: xPct === undefined ? 0 : (xPct / 100) * FLOOR_WIDTH,
    clientY: yPct === undefined ? 0 : (yPct / 100) * FLOOR_HEIGHT,
  })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}
