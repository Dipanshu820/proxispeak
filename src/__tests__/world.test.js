import { describe, it, expect } from 'vitest'
import { isWebGLAvailable } from '../utils/webgl.js'
import { collidesWithFurniture, DEFAULT_FLOOR, EARSHOT_RADIUS_PX, FURNITURE } from '../utils/collision.js'
import {
  EARSHOT_WORLD_RADIUS,
  FURNITURE_3D,
  PX_PER_WORLD_UNIT,
  ROOMS_3D,
  WORLD_DEPTH,
  WORLD_WIDTH,
  WALLS,
  directionFromKeys,
  percentDistancePx,
  percentToWorld,
  rectToWorld,
  stepAvatar,
  stepToward,
  worldToPercent,
} from '../three/world.js'

describe('3D world coordinates', () => {
  it('maps the floor corners of percentage space onto the rendered floor', () => {
    expect(percentToWorld(0, 0)).toEqual([-50, 0, -30])
    expect(percentToWorld(100, 100)).toEqual([50, 0, 30])
    expect(percentToWorld(50, 50)).toEqual([0, 0, 0])
  })

  it('round-trips percentages through world space', () => {
    for (const point of [
      { x: 0, y: 0 },
      { x: 3, y: 4 },
      { x: 48, y: 66 },
      { x: 100, y: 100 },
    ]) {
      const [wx, , wz] = percentToWorld(point.x, point.y)
      const back = worldToPercent(wx, wz)
      expect(back.x).toBeCloseTo(point.x, 9)
      expect(back.y).toBeCloseTo(point.y, 9)
    }
  })

  it('keeps the earshot radius in the same pixel space as the audio mix', () => {
    // 100 px earshot on the 900 px-wide floor == 11.11 world units.
    expect(PX_PER_WORLD_UNIT).toBe(9)
    expect(EARSHOT_WORLD_RADIUS).toBeCloseTo(EARSHOT_RADIUS_PX / 9, 9)
    expect(EARSHOT_WORLD_RADIUS).toBeGreaterThan(10)
  })

  it('projects every solid furniture rectangle and zone from the shared layout', () => {
    expect(FURNITURE_3D).toHaveLength(FURNITURE.length)
    expect(ROOMS_3D).toHaveLength(5)

    for (const item of FURNITURE_3D) {
      expect(Number.isFinite(item.centerX)).toBe(true)
      expect(Number.isFinite(item.centerZ)).toBe(true)
      expect(item.width).toBeGreaterThan(0)
      expect(item.depth).toBeGreaterThan(0)
      expect(item.height).toBeGreaterThan(0)
    }

    // Desks and sofas must land inside the rendered floor, not off the plane.
    for (const item of FURNITURE_3D) {
      expect(Math.abs(item.centerX) + item.width / 2).toBeLessThanOrEqual(WORLD_WIDTH / 2 + 0.001)
      expect(Math.abs(item.centerZ) + item.depth / 2).toBeLessThanOrEqual(WORLD_DEPTH / 2 + 0.001)
    }
  })

  it('wraps the floor with walls that stay inside the projected bounds', () => {
    expect(WALLS.map((wall) => wall.id)).toEqual(['back', 'left', 'right', 'front'])
    for (const wall of WALLS) {
      expect(wall.size.every((value) => value > 0)).toBe(true)
      expect(wall.position.every(Number.isFinite)).toBe(true)
    }
  })

  it('derives furniture rectangles with the same relative size as the collision model', () => {
    const desk = FURNITURE.find((item) => item.kind === 'desk')
    const world = rectToWorld(desk)
    expect(world.width).toBeCloseTo((desk.w / 100) * WORLD_WIDTH, 9)
    expect(world.depth).toBeCloseTo((desk.h / 100) * WORLD_DEPTH, 9)
  })
})

describe('avatar movement in world space', () => {
  const freePoint = { x: 48, y: 66 } // corridor in the open workspace

  it('maps WASD and arrow keys to the same direction', () => {
    expect(directionFromKeys({ w: true })).toEqual({ x: 0, y: -1 })
    expect(directionFromKeys({ arrowdown: true })).toEqual({ x: 0, y: 1 })
    expect(directionFromKeys({ a: true, d: true })).toEqual({ x: 0, y: 0 })
    expect(directionFromKeys({ d: true, s: true })).toEqual({ x: 1, y: 1 })
    expect(directionFromKeys(undefined)).toEqual({ x: 0, y: 0 })
  })

  it('moves a fixed physical distance per second regardless of frame rate', () => {
    const oneBigStep = stepAvatar(freePoint, { x: 1, y: 0 }, 0.1, { maxStepPx: 1000 })
    const tenSmallSteps = Array.from({ length: 10 }).reduce(
      (position) => stepAvatar(position, { x: 1, y: 0 }, 0.01, { maxStepPx: 1000 }),
      freePoint,
    )

    expect(oneBigStep.moved).toBe(true)
    expect(tenSmallSteps.x).toBeCloseTo(oneBigStep.x, 6)
    expect(tenSmallSteps.y).toBeCloseTo(oneBigStep.y, 6)
  })

  it('normalizes diagonals so they are not faster than straight lines', () => {
    const straight = stepAvatar(freePoint, { x: 1, y: 0 }, 0.05)
    const diagonal = stepAvatar(freePoint, { x: 1, y: 1 }, 0.05)

    const straightPx = percentDistancePx(freePoint, straight)
    const diagonalPx = percentDistancePx(freePoint, diagonal)

    // Without normalization a diagonal covers ~41% more ground. The shared
    // collision solver quantizes a slide to 0.05% samples, so a single tiny
    // diagonal frame can be a few percent short; it must never be longer.
    expect(diagonalPx).toBeLessThanOrEqual(straightPx + 1e-9)
    expect(diagonalPx).toBeGreaterThan(straightPx * 0.95)
  })

  it('ignores zero-length, negative, and non-finite deltas', () => {
    for (const delta of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(stepAvatar(freePoint, { x: 1, y: 0 }, delta)).toEqual({ ...freePoint, moved: false })
    }
    expect(stepAvatar(freePoint, { x: 0, y: 0 }, 0.016).moved).toBe(false)
  })

  it('cannot walk through solid furniture', () => {
    const desk = FURNITURE.find((item) => item.kind === 'desk')
    const insideDesk = { x: desk.x + desk.w / 2, y: desk.y + desk.h / 2 }

    const result = stepAvatar(freePoint, { x: 1, y: 0 }, 5, { maxStepPx: 5000 })

    expect(collidesWithFurniture(insideDesk.x, insideDesk.y, DEFAULT_FLOOR)).toBe(true)
    expect(collidesWithFurniture(result.x, result.y, DEFAULT_FLOOR)).toBe(false)
  })

  it('stays inside the floor boundary even with a huge step', () => {
    const result = stepAvatar(freePoint, { x: -1, y: -1 }, 10, { maxStepPx: 100_000 })
    expect(result.x).toBeGreaterThan(0)
    expect(result.x).toBeLessThan(100)
    expect(result.y).toBeGreaterThan(0)
    expect(result.y).toBeLessThan(100)
    expect(collidesWithFurniture(result.x, result.y, DEFAULT_FLOOR)).toBe(false)
  })

  it('walks toward a clicked point and stops when it arrives', () => {
    const target = { x: 40, y: 66 }
    let position = { x: 48, y: 66 }
    let arrived = false

    for (let i = 0; i < 200 && !arrived; i += 1) {
      const next = stepToward(position, target, 0.016)
      position = { x: next.x, y: next.y }
      arrived = next.arrived
    }

    expect(arrived).toBe(true)
    expect(Math.abs(position.x - target.x)).toBeLessThan(0.5)
    expect(Math.abs(position.y - target.y)).toBeLessThan(0.5)
  })

  it('treats an unreachable click inside furniture as blocked, never as a teleport', () => {
    const desk = FURNITURE.find((item) => item.kind === 'desk')
    const target = { x: desk.x + desk.w / 2, y: desk.y + desk.h / 2 }
    const next = stepToward(freePoint, target, 1, { maxStepPx: 5000 })

    // The stepping logic never places the avatar inside the solid.
    expect(collidesWithFurniture(next.x, next.y, DEFAULT_FLOOR)).toBe(false)
  })
})

describe('WebGL availability', () => {
  it('reports no WebGL in jsdom so the accessible floor is used', () => {
    expect(isWebGLAvailable()).toBe(false)
  })
})
