// World-space geometry and movement for the 3D office.
//
// The 3D scene is not a separate coordinate system. It is a scaled projection of
// the same floor percentages used by the collision model and the server:
//
//   100% of floor width  -> 100 world units (x: -50 … +50)
//   100% of floor height ->  60 world units (z: -30 … +30)
//   1 world unit          =  9 floor pixels (the collision model's 900×540 floor)
//
// That last constant is what keeps proximity honest: the earshot radius is
// defined in pixels by `collision.js`, and dividing it by 9 gives the radius of
// the ring drawn around the avatar. A conversation that is audible on screen is
// audible in the audio graph, because both use the same pixel distance.
//
// This module intentionally imports nothing from three/@react-three so it can be
// unit tested in jsdom without a WebGL context.

import {
  EARSHOT_RADIUS_PX,
  DEFAULT_FLOOR,
  resolveCollision,
  clampToFloorBoundaries,
  FURNITURE,
  OFFICE_LAYOUT,
} from '../utils/collision.js'

export const WORLD_WIDTH = 100
export const WORLD_DEPTH = 60
export const PX_PER_WORLD_UNIT = DEFAULT_FLOOR.width / WORLD_WIDTH // 9

export const EARSHOT_WORLD_RADIUS = EARSHOT_RADIUS_PX / PX_PER_WORLD_UNIT
export const AVATAR_WORLD_RADIUS = 20 / PX_PER_WORLD_UNIT

export const MOVE_SPEED_PX_PER_SEC = 90
export const MAX_STEP_PX = 8
export const ARRIVAL_EPSILON_PX = 3

export const FURNITURE_HEIGHT = {
  desk: 0.95,
  meeting: 1,
  sofa: 0.85,
}

export function percentToWorld(xPercent, yPercent, height = 0) {
  return [
    (xPercent / 100) * WORLD_WIDTH - WORLD_WIDTH / 2,
    height,
    (yPercent / 100) * WORLD_DEPTH - WORLD_DEPTH / 2,
  ]
}

export function worldToPercent(x, z) {
  return {
    x: ((x + WORLD_WIDTH / 2) / WORLD_WIDTH) * 100,
    y: ((z + WORLD_DEPTH / 2) / WORLD_DEPTH) * 100,
  }
}

// A floor-percentage rectangle (as stored by collision.js) in world units.
export function rectToWorld(rect) {
  const [centerX, , centerZ] = percentToWorld(rect.x + rect.w / 2, rect.y + rect.h / 2)
  return {
    centerX,
    centerZ,
    width: (rect.w / 100) * WORLD_WIDTH,
    depth: (rect.h / 100) * WORLD_DEPTH,
  }
}

export const FURNITURE_3D = FURNITURE.map((item) => ({
  ...item,
  ...rectToWorld(item),
  height: FURNITURE_HEIGHT[item.kind] ?? 0.95,
}))

export const ROOMS_3D = OFFICE_LAYOUT.rooms.map((room) => ({
  ...room,
  ...rectToWorld(room),
}))

// Perimeter walls. The back and sides are tall enough to read as a room; the
// front edge is a low curb so the camera (which looks in from +z) is never
// blocked. Avatars cannot leave the floor at all: movement is clamped to the
// floor bounds in pixels, which is the collision model's own boundary, not a
// separate wall rule that could disagree with it.
export const WALLS = [
  { id: 'back', position: [0, 1.1, -WORLD_DEPTH / 2], size: [WORLD_WIDTH, 2.2, 0.5] },
  { id: 'left', position: [-WORLD_WIDTH / 2, 1.1, 0], size: [0.5, 2.2, WORLD_DEPTH] },
  { id: 'right', position: [WORLD_WIDTH / 2, 1.1, 0], size: [0.5, 2.2, WORLD_DEPTH] },
  { id: 'front', position: [0, 0.12, WORLD_DEPTH / 2], size: [WORLD_WIDTH, 0.24, 0.5] },
]

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

export function directionFromKeys(keys) {
  const pressed = keys || {}
  let x = 0
  let y = 0
  if (pressed.w || pressed.arrowup) y -= 1
  if (pressed.s || pressed.arrowdown) y += 1
  if (pressed.a || pressed.arrowleft) x -= 1
  if (pressed.d || pressed.arrowright) x += 1
  return { x, y }
}

function collisionOptions(overrides = {}) {
  return {
    floorWidth: overrides.floorWidth ?? DEFAULT_FLOOR.width,
    floorHeight: overrides.floorHeight ?? DEFAULT_FLOOR.height,
    radiusPx: overrides.radiusPx ?? 20,
  }
}

// Advance the avatar one animation frame in `direction` (unit or raw vector).
// The step is proportional to elapsed seconds, so the avatar covers the same
// ground at 30 fps, 60 fps or 144 fps, and a backgrounded tab cannot teleport it.
export function stepAvatar(
  position,
  direction,
  deltaSeconds,
  { speedPxPerSecond = MOVE_SPEED_PX_PER_SEC, maxStepPx = MAX_STEP_PX, ...options } = {},
) {
  const magnitude = Math.hypot(direction?.x || 0, direction?.y || 0)
  if (
    !position ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    magnitude === 0 ||
    !Number.isFinite(deltaSeconds) ||
    deltaSeconds <= 0
  ) {
    return { x: position?.x ?? 0, y: position?.y ?? 0, moved: false }
  }

  const opts = collisionOptions(options)
  const stepPx = Math.min(maxStepPx, speedPxPerSecond * deltaSeconds)
  const deltaXPercent = ((direction.x / magnitude) * stepPx * 100) / opts.floorWidth
  const deltaYPercent = ((direction.y / magnitude) * stepPx * 100) / opts.floorHeight

  const clamped = clampToFloorBoundaries(
    position.x + deltaXPercent,
    position.y + deltaYPercent,
    opts,
  )
  const resolved = resolveCollision(position.x, position.y, clamped.x, clamped.y, opts)

  return {
    x: resolved.x,
    y: resolved.y,
    moved: resolved.x !== position.x || resolved.y !== position.y,
  }
}

// Walk a clicked point. Distances are measured in floor pixels (not percentages)
// so the arrival threshold is a physical length even though the floor is not
// square.
export function stepToward(
  position,
  target,
  deltaSeconds,
  { speedPxPerSecond = MOVE_SPEED_PX_PER_SEC, maxStepPx = MAX_STEP_PX, ...options } = {},
) {
  if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) {
    return { x: position.x, y: position.y, moved: false, arrived: true }
  }

  const opts = collisionOptions(options)
  const dxPx = ((target.x - position.x) / 100) * opts.floorWidth
  const dyPx = ((target.y - position.y) / 100) * opts.floorHeight
  const distancePx = Math.hypot(dxPx, dyPx)

  if (distancePx <= ARRIVAL_EPSILON_PX) {
    return { x: position.x, y: position.y, moved: false, arrived: true }
  }

  const next = stepAvatar(
    position,
    { x: dxPx, y: dyPx },
    deltaSeconds,
    { speedPxPerSecond, maxStepPx, ...opts },
  )
  const remainingPx = Math.hypot(
    ((target.x - next.x) / 100) * opts.floorWidth,
    ((target.y - next.y) / 100) * opts.floorHeight,
  )

  return { ...next, arrived: remainingPx <= ARRIVAL_EPSILON_PX }
}

// Convenience for UI copy and tests: pixel distance between two percentage
// positions using the same floor the collision model assumes.
export function percentDistancePx(a, b, floorWidth = DEFAULT_FLOOR.width, floorHeight = DEFAULT_FLOOR.height) {
  return Math.hypot(
    ((a.x - b.x) / 100) * floorWidth,
    ((a.y - b.y) / 100) * floorHeight,
  )
}
