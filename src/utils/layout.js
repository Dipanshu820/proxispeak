// Layout persistence for the virtual office.
//
// Pure, testable helpers shared by the React component and the tests, so the
// behaviour that ships is the behaviour that is verified (no duplicated copy of
// this logic inside the test suite).
//
// Stored shape (localStorage key `proxispeak-layout`):
//   [{ "id": "you", "x": 48, "y": 66 }, ...]
//
// Reads are defensive: anything that is not an array of `{id, x, y}` entries
// with finite numbers is reported as unreadable instead of throwing, and
// restored positions are pushed off furniture so a stale layout can never place
// an avatar inside a desk.

import { DEFAULT_FLOOR, findNearestFreePosition } from './collision.js'

export const LAYOUT_KEY = 'proxispeak-layout'

function getStorage() {
  try {
    // Accessing localStorage itself can throw (e.g. blocked cookies).
    if (typeof localStorage === 'undefined' || localStorage === null) return null
    return localStorage
  } catch {
    return null
  }
}

export function serializeLayout(people) {
  return people
    .filter(
      (person) =>
        person &&
        typeof person.id === 'string' &&
        Number.isFinite(person.x) &&
        Number.isFinite(person.y),
    )
    .map(({ id, x, y }) => ({ id, x, y }))
}

// Persist the current positions. Returns { saved, reason? } instead of throwing.
export function saveLayout(people, storage = getStorage()) {
  if (!storage) return { saved: false, reason: 'storage_unavailable' }
  try {
    storage.setItem(LAYOUT_KEY, JSON.stringify(serializeLayout(people)))
    return { saved: true }
  } catch {
    return { saved: false, reason: 'write_failed' }
  }
}

// Normalize arbitrary parsed JSON into a list of valid positions, or null when
// the value is not shaped like a saved layout at all.
export function normalizePositions(value) {
  if (!Array.isArray(value)) return null
  return value
    .filter(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof entry.id === 'string' &&
        Number.isFinite(entry.x) &&
        Number.isFinite(entry.y),
    )
    .map(({ id, x, y }) => ({ id, x, y }))
}

// Read the saved layout. Never throws:
//   { ok: true,  positions: [...] }
//   { ok: false, reason: 'storage_unavailable' | 'missing' | 'invalid_json' | 'invalid_shape' | 'empty' }
export function readSavedLayout(storage = getStorage()) {
  if (!storage) return { ok: false, reason: 'storage_unavailable' }

  let raw
  try {
    raw = storage.getItem(LAYOUT_KEY)
  } catch {
    return { ok: false, reason: 'storage_unavailable' }
  }

  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, reason: 'missing' }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'invalid_json' }
  }

  const positions = normalizePositions(parsed)
  if (!positions) return { ok: false, reason: 'invalid_shape' }
  if (positions.length === 0) return { ok: false, reason: 'empty' }

  return { ok: true, positions }
}

// Apply saved positions to a roster, keeping every other field intact and
// pushing any position that overlaps furniture out to the nearest free floor.
export function applySavedLayout(people, positions, options) {
  const collisionOptions = {
    floorWidth: (options && options.floorWidth) || DEFAULT_FLOOR.width,
    floorHeight: (options && options.floorHeight) || DEFAULT_FLOOR.height,
    radiusPx: options && options.radiusPx,
  }

  return people.map((person) => {
    const saved = positions.find((entry) => entry.id === person.id)
    if (!saved) return person
    const safe = findNearestFreePosition(saved.x, saved.y, collisionOptions)
    return { ...person, x: safe.x, y: safe.y }
  })
}

// Human readable toast text for a failed read.
export function layoutErrorMessage(reason) {
  switch (reason) {
    case 'missing':
      return 'No saved layout yet.'
    case 'storage_unavailable':
      return 'Local storage is not available in this browser.'
    case 'empty':
      return 'The saved layout was empty.'
    default:
      return 'Could not read saved layout.'
  }
}
