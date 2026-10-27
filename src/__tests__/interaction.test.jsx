import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, rerender, fireEvent, screen, act } from '@testing-library/react'
import VirtualOffice from '../pages/VirtualOffice'
import { INITIAL_PEOPLE } from '../utils/people'
import { collidesWithFurniture } from '../utils/collision'
import {
  FLOOR_OPTIONS,
  avatarElement,
  avatarPosition,
  blurWindow,
  installOfficeHarness,
  keyDown,
  keyUp,
  pointerEvent,
} from './officeHarness'

let harness

afterEach(() => {
  harness?.uninstall()
  harness = null
})

async function mountOffice() {
  harness = installOfficeHarness()
  const view = render(<VirtualOffice onHome={() => {}} />)
  // The office requests a session as soon as it mounts. In unit tests the
  // hermetic fetch stub in setup.js rejects that request, and the resulting
  // setState lands in a microtask after render() returns — outside act(), which
  // React reports as a warning and which makes the settled component state
  // order-dependent. Flush the rejection here so each test starts settled.
  await act(async () => {})
  return view.container
}

describe('Initial office state (real DOM)', () => {
  it('starts every avatar on free floor', async () => {
    const container = await mountOffice()

    for (const person of INITIAL_PEOPLE) {
      const { x, y } = avatarPosition(container, person.name)
      expect(Number.isFinite(x), person.id).toBe(true)
      expect(
        collidesWithFurniture(x, y, FLOOR_OPTIONS),
        `${person.id} starts on top of furniture at (${x}, ${y})`,
      ).toBe(false)
    }
  })

  it('renders the earshot circle at 200px diameter centered on the avatar', async () => {
    const container = await mountOffice()
    const circle = container.querySelector('.earshot-circle')
    const { x, y } = avatarPosition(container, 'You')

    expect(circle).toBeTruthy()
    expect(circle.style.width).toBe('200px')
    expect(circle.style.height).toBe('200px')
    expect(circle.style.left).toBe(`${x}%`)
    expect(circle.style.top).toBe(`${y}%`)
  })
})

describe('Keyboard movement (real animation frames)', () => {
  it('keeps moving while a key is held instead of freezing after one step', async () => {
    const container = await mountOffice()
    const start = avatarPosition(container)

    keyDown('d')
    harness.pumpFrames(8)
    const afterEight = avatarPosition(container)

    expect(afterEight.x).toBeGreaterThan(start.x + 0.75)
    expect(afterEight.y).toBe(start.y)

    // More frames must keep advancing (no stuck state, no stale position).
    harness.pumpFrames(6)
    const afterFourteen = avatarPosition(container)
    expect(afterFourteen.x).toBeGreaterThan(afterEight.x + 0.5)
  })

  it('moves in all four directions with WASD and the arrow keys', async () => {
    // Render once and reuse the same component instance for all eight
    // directions. Between iterations we release the previous key, clear any
    // leftover animation callbacks, record the current position, press the
    // next key, run four frames, and assert movement in the expected
    // direction. This avoids the previous pattern of uninstalling and
    // reinstalling the harness eight times (which called
    // vi.unstubAllGlobals() each pass and made the test 3–4× slower with
    // occasional 5s timeouts) as well as the later pattern of unmount +
    // re-render eight times (which also timed out under load).
    harness = installOfficeHarness()
    const container = render(<VirtualOffice onHome={() => {}} />).container
    await act(async () => {})

    const cases = [
      { key: 'd', axis: 'x', sign: 1 },
      { key: 'a', axis: 'x', sign: -1 },
      { key: 'w', axis: 'y', sign: -1 },
      { key: 's', axis: 'y', sign: 1 },
      { key: 'ArrowRight', axis: 'x', sign: 1 },
      { key: 'ArrowLeft', axis: 'x', sign: -1 },
      { key: 'ArrowUp', axis: 'y', sign: -1 },
      { key: 'ArrowDown', axis: 'y', sign: 1 },
    ]

    let previousKey = null
    for (const { key, axis, sign } of cases) {
      if (previousKey) keyUp(previousKey)
      const start = avatarPosition(container)
      keyDown(key)
      harness.pumpFrames(4)
      const now = avatarPosition(container)
      const delta = (now[axis] - start[axis]) * sign
      expect(delta, `${key} should move ${axis}`).toBeGreaterThan(0.2)
      previousKey = key
    }
    if (previousKey) keyUp(previousKey)
  })

  it('stops moving when the key is released', async () => {
    const container = await mountOffice()
    keyDown('d')
    harness.pumpFrames(4)
    const moving = avatarPosition(container)

    keyUp('d')
    harness.pumpFrames(6)
    expect(avatarPosition(container)).toEqual(moving)
  })

  it('stops moving when the window loses focus with a key still held', async () => {
    const container = await mountOffice()
    keyDown('d')
    harness.pumpFrames(4)

    blurWindow()
    const afterBlur = avatarPosition(container)

    harness.pumpFrames(6)
    expect(avatarPosition(container)).toEqual(afterBlur)
  })

  it('does not hijack arrow keys that belong to a focused control', async () => {
    const container = await mountOffice()
    const start = avatarPosition(container)
    const slider = container.querySelector('#output-volume')

    slider.focus()
    // fireEvent returns false when the handler called preventDefault().
    expect(fireEvent.keyDown(slider, { key: 'ArrowRight' })).toBe(true)

    harness.pumpFrames(5)
    expect(avatarPosition(container)).toEqual(start)
  })
})

describe('Pointer drag (real handlers)', () => {
  it('drags the avatar to a free position on open floor', async () => {
    const container = await mountOffice()
    const avatar = avatarElement(container)

    pointerEvent(avatar, 'pointerdown', { xPct: 48, yPct: 66 })
    pointerEvent(container.querySelector('.office-floor'), 'pointermove', { xPct: 55, yPct: 66 })
    pointerEvent(container.querySelector('.office-floor'), 'pointerup', { xPct: 55, yPct: 66 })

    const { x, y } = avatarPosition(container)
    expect(x).toBeCloseTo(55, 3)
    expect(y).toBeCloseTo(66, 3)
    expect(collidesWithFurniture(x, y, FLOOR_OPTIONS)).toBe(false)
  })

  it('never drops the avatar inside furniture', async () => {
    const container = await mountOffice()
    const avatar = avatarElement(container)
    const floor = container.querySelector('.office-floor')

    // A desk in the open workspace spans x 8.49%–23.13%, y 49.4%–55.67%.
    pointerEvent(avatar, 'pointerdown', { xPct: 48, yPct: 66 })
    pointerEvent(floor, 'pointermove', { xPct: 15.81, yPct: 52.5 })
    pointerEvent(floor, 'pointerup', { xPct: 15.81, yPct: 52.5 })

    const { x, y } = avatarPosition(container)
    expect(collidesWithFurniture(x, y, FLOOR_OPTIONS)).toBe(false)
    // It slid underneath the desk instead of being dropped on top of it.
    expect(y).toBeGreaterThan(55.67)
  })

  it('can be dragged back out of a blocked area', async () => {
    const container = await mountOffice()
    const avatar = avatarElement(container)
    const floor = container.querySelector('.office-floor')

    pointerEvent(avatar, 'pointerdown', { xPct: 48, yPct: 66 })
    pointerEvent(floor, 'pointermove', { xPct: 15.81, yPct: 52.5 })
    pointerEvent(floor, 'pointermove', { xPct: 55, yPct: 66 })
    pointerEvent(floor, 'pointerup', { xPct: 55, yPct: 66 })

    const { x, y } = avatarPosition(container)
    expect(x).toBeCloseTo(55, 3)
    expect(collidesWithFurniture(x, y, FLOOR_OPTIONS)).toBe(false)
  })

  it('stops following the pointer once the drag ends', async () => {
    const container = await mountOffice()
    const avatar = avatarElement(container)
    const floor = container.querySelector('.office-floor')

    pointerEvent(avatar, 'pointerdown', { xPct: 48, yPct: 66 })
    pointerEvent(floor, 'pointermove', { xPct: 55, yPct: 66 })
    pointerEvent(floor, 'pointerup', { xPct: 55, yPct: 66 })
    const dropped = avatarPosition(container)

    pointerEvent(floor, 'pointermove', { xPct: 70, yPct: 80 })
    expect(avatarPosition(container)).toEqual(dropped)
  })

  it('keeps the avatar inside the floor when the pointer leaves it', async () => {
    const container = await mountOffice()
    const avatar = avatarElement(container)
    const floor = container.querySelector('.office-floor')

    pointerEvent(avatar, 'pointerdown', { xPct: 48, yPct: 66 })
    pointerEvent(floor, 'pointermove', { xPct: 400, yPct: 400 })
    pointerEvent(floor, 'pointerup', { xPct: 400, yPct: 400 })

    const { x, y } = avatarPosition(container)
    expect(x).toBeLessThan(100)
    expect(y).toBeLessThan(100)
    expect(collidesWithFurniture(x, y, FLOOR_OPTIONS)).toBe(false)
  })

  it('still moves with the keyboard after a drag', async () => {
    const container = await mountOffice()
    const avatar = avatarElement(container)
    const floor = container.querySelector('.office-floor')

    pointerEvent(avatar, 'pointerdown', { xPct: 48, yPct: 66 })
    pointerEvent(floor, 'pointermove', { xPct: 55, yPct: 66 })
    pointerEvent(floor, 'pointerup', { xPct: 55, yPct: 66 })

    const dropped = avatarPosition(container)
    keyDown('d')
    harness.pumpFrames(4)

    expect(avatarPosition(container).x).toBeGreaterThan(dropped.x)
  })
})

describe('Colleague list', () => {
  it('lists every colleague that is drawn on the floor', async () => {
    const container = await mountOffice()
    const list = container.querySelector('#colleagues')
    const names = [...list.querySelectorAll('[aria-label]')].map((el) =>
      el.getAttribute('aria-label').split(',')[0],
    )

    for (const person of INITIAL_PEOPLE.filter((p) => !p.you)) {
      expect(names, person.id).toContain(person.name)
    }
    expect(screen.getAllByText(/demo/i).length).toBeGreaterThan(0)
  })
})
