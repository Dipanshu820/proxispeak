import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import VirtualOffice from '../pages/VirtualOffice'
import {
  LAYOUT_KEY,
  applySavedLayout,
  layoutErrorMessage,
  normalizePositions,
  readSavedLayout,
  saveLayout,
  serializeLayout,
} from '../utils/layout'
import { createInitialPeople } from '../utils/people'
import { collidesWithFurniture } from '../utils/collision'
import { FLOOR_OPTIONS, avatarPosition, installOfficeHarness, renderSettled } from './officeHarness'

const brokenStorage = {
  getItem() {
    throw new Error('blocked')
  },
  setItem() {
    throw new Error('blocked')
  },
}

let harness
afterEach(() => {
  harness?.uninstall()
  harness = null
})

// Persistence tests only need the component to render; they do not pump
// animation frames, dispatch pointer events, or measure floor dimensions.
// Installing the office harness here is unnecessary and, on Windows where
// vitest may reuse the same worker across files, leaves prototype/mock state
// that slows the next mount by several seconds.
async function mountOffice() {
  return renderSettled(<VirtualOffice onHome={() => {}} />)
}

describe('Layout serialization', () => {
  it('stores only id, x and y', async () => {
    const people = [
      { id: 'you', x: 50, y: 60, name: 'You', role: 'Local User', emoji: '🙂' },
    ]
    expect(serializeLayout(people)).toEqual([{ id: 'you', x: 50, y: 60 }])
  })

  it('skips entries without an id or numeric coordinates', async () => {
    expect(
      serializeLayout([
        { id: 'you', x: 50, y: 60 },
        { x: 10, y: 10 },
        { id: 'leo', x: null, y: 10 },
        { id: 'sara', x: '30', y: 20 },
        null,
      ]),
    ).toEqual([{ id: 'you', x: 50, y: 60 }])
  })
})

describe('saveLayout / readSavedLayout', () => {
  it('round trips positions through localStorage', async () => {
    const people = createInitialPeople()
    expect(saveLayout(people)).toEqual({ saved: true })

    const stored = JSON.parse(localStorage.getItem(LAYOUT_KEY))
    expect(stored).toHaveLength(people.length)
    expect(stored).toContainEqual({ id: 'you', x: 48, y: 66 })

    const result = readSavedLayout()
    expect(result.ok).toBe(true)
    expect(result.positions).toContainEqual({ id: 'you', x: 48, y: 66 })
  })

  it('reports missing data instead of throwing', async () => {
    expect(readSavedLayout()).toEqual({ ok: false, reason: 'missing' })
  })

  it('rejects unparseable JSON', async () => {
    localStorage.setItem(LAYOUT_KEY, 'not-valid-json')
    expect(readSavedLayout()).toEqual({ ok: false, reason: 'invalid_json' })
  })

  it('rejects JSON that is not a positions array', async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ foo: 'bar' }))
    expect(readSavedLayout()).toEqual({ ok: false, reason: 'invalid_shape' })

    localStorage.setItem(LAYOUT_KEY, JSON.stringify('hello'))
    expect(readSavedLayout()).toEqual({ ok: false, reason: 'invalid_shape' })

    localStorage.setItem(LAYOUT_KEY, JSON.stringify([{ nope: true }]))
    expect(readSavedLayout()).toEqual({ ok: false, reason: 'empty' })
  })

  it('ignores entries that are not usable positions but keeps the good ones', async () => {
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify([{ id: 'you', x: 30, y: 30 }, { x: 5, y: 5 }, { id: 'leo', x: 'oops', y: 2 }]),
    )
    const result = readSavedLayout()
    expect(result.ok).toBe(true)
    expect(result.positions).toEqual([{ id: 'you', x: 30, y: 30 }])
  })

  it('does not throw when storage rejects reads or writes', async () => {
    // The storage object exists but every call throws (blocked cookies, quota).
    expect(saveLayout(createInitialPeople(), brokenStorage)).toEqual({
      saved: false,
      reason: 'write_failed',
    })
    expect(readSavedLayout(brokenStorage)).toEqual({
      ok: false,
      reason: 'storage_unavailable',
    })
  })

  it('normalizes only well formed entries', async () => {
    expect(normalizePositions({})).toBeNull()
    expect(normalizePositions(null)).toBeNull()
    expect(normalizePositions([{ id: 'a', x: 1, y: 2 }])).toEqual([{ id: 'a', x: 1, y: 2 }])
  })

  it('maps read failures to human readable messages', async () => {
    expect(layoutErrorMessage('missing')).toBe('No saved layout yet.')
    expect(layoutErrorMessage('storage_unavailable')).toMatch(/local storage/i)
    expect(layoutErrorMessage('invalid_json')).toBe('Could not read saved layout.')
    expect(layoutErrorMessage('invalid_shape')).toBe('Could not read saved layout.')
  })
})

describe('applySavedLayout', () => {
  it('only moves the avatars present in the saved layout', async () => {
    const people = createInitialPeople()
    const result = applySavedLayout(people, [{ id: 'you', x: 35, y: 25 }], FLOOR_OPTIONS)

    expect(result.find((p) => p.id === 'you')).toMatchObject({ x: 35, y: 25 })
    expect(result.find((p) => p.id === 'leo')).toEqual(people.find((p) => p.id === 'leo'))
  })

  it('never restores an avatar inside furniture', async () => {
    const people = createInitialPeople()
    // (18, 18) is inside the meeting table.
    const result = applySavedLayout(people, [{ id: 'you', x: 18, y: 18 }], FLOOR_OPTIONS)
    const you = result.find((p) => p.id === 'you')

    expect(collidesWithFurniture(you.x, you.y, FLOOR_OPTIONS)).toBe(false)
  })
})

describe('Layout controls in the office', () => {
  it('reports when there is nothing saved yet', async () => {
    const view = await mountOffice()
    fireEvent.click(screen.getByRole('button', { name: 'Saved Layouts' }))
    expect(screen.getByRole('status').textContent).toBe('No saved layout yet.')
  })

  it('saves the current positions from the toolbar', async () => {
    await mountOffice()
    fireEvent.click(screen.getByRole('button', { name: 'Save current avatar positions' }))

    expect(screen.getByRole('status').textContent).toBe('Layout saved in this browser.')
    const stored = JSON.parse(localStorage.getItem(LAYOUT_KEY))
    expect(stored.length).toBeGreaterThan(0)
  })

  it('restores a saved position when asked', async () => {
    const view = await mountOffice()
    localStorage.setItem(LAYOUT_KEY, JSON.stringify([{ id: 'you', x: 35, y: 25 }]))

    fireEvent.click(screen.getByRole('button', { name: 'Saved Layouts' }))

    expect(screen.getByRole('status').textContent).toBe('Saved layout restored.')
    expect(avatarPosition(view.container, 'You').x).toBeCloseTo(35, 3)
  })

  it('survives stored data that parses but has the wrong shape', async () => {
    const view = await mountOffice()
    const before = avatarPosition(view.container, 'You')
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ foo: 'bar' }))

    fireEvent.click(screen.getByRole('button', { name: 'Saved Layouts' }))

    expect(screen.getByRole('status').textContent).toBe('Could not read saved layout.')
    expect(avatarPosition(view.container, 'You')).toEqual(before)
  })

  it('survives unreadable stored data', async () => {
    await mountOffice()
    localStorage.setItem(LAYOUT_KEY, '{"broken":')

    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: 'Saved Layouts' })),
    ).not.toThrow()
    expect(screen.getByRole('status').textContent).toBe('Could not read saved layout.')
  })

  it('never restores the avatar inside furniture', async () => {
    const view = await mountOffice()
    localStorage.setItem(LAYOUT_KEY, JSON.stringify([{ id: 'you', x: 18, y: 18 }]))

    fireEvent.click(screen.getByRole('button', { name: 'Saved Layouts' }))

    const { x, y } = avatarPosition(view.container, 'You')
    expect(collidesWithFurniture(x, y, FLOOR_OPTIONS)).toBe(false)
  })

  it('resets to the default roster positions', async () => {
    const view = await mountOffice()
    localStorage.setItem(LAYOUT_KEY, JSON.stringify([{ id: 'you', x: 35, y: 25 }]))
    fireEvent.click(screen.getByRole('button', { name: 'Saved Layouts' }))
    expect(avatarPosition(view.container, 'You').x).toBeCloseTo(35, 3)

    fireEvent.click(screen.getByRole('button', { name: 'Reset avatar positions to default' }))

    expect(screen.getByRole('status').textContent).toBe('Avatar positions reset.')
    expect(avatarPosition(view.container, 'You').x).toBeCloseTo(48, 3)
    cleanup()
  })
})
