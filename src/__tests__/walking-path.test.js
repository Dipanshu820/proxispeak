import { describe, it, expect } from 'vitest';
import {
  AVATAR_RADIUS_PX,
  DEFAULT_FLOOR,
  FURNITURE,
  clampToFloorBoundaries,
  collidesWithFurniture,
  resolveCollision,
} from '../utils/collision';

const FLOOR = { floorWidth: DEFAULT_FLOOR.width, floorHeight: DEFAULT_FLOOR.height };
const point = (x, y) => ({ x, y });

// A helper that mirrors what the component does every frame: clamp the desired
// position inside the floor, then resolve it against the furniture.
function walk(from, to, floor = FLOOR) {
  const clamped = clampToFloorBoundaries(to.x, to.y, floor);
  return resolveCollision(from.x, from.y, clamped.x, clamped.y, floor);
}

describe('Walking paths across the office floor', () => {
  describe('open floor is reachable', () => {
    it('allows standing in the gaps between the top rooms', () => {
      // Meeting (ends x33%) / focus (starts x37%) and focus (ends x63%) / lounge
      // (starts x67%) both leave walkable gaps near the top of the floor.
      expect(collidesWithFurniture(35, 18, FLOOR)).toBe(false);
      expect(collidesWithFurniture(65, 18, FLOOR)).toBe(false);
    });

    it('allows standing below the top band of rooms', () => {
      expect(collidesWithFurniture(18, 35, FLOOR)).toBe(false);
      expect(collidesWithFurniture(80, 35, FLOOR)).toBe(false);
    });

    it('allows standing in the middle of the floor', () => {
      expect(collidesWithFurniture(49, 25.5, FLOOR)).toBe(false);
      expect(collidesWithFurniture(66, 50, FLOOR)).toBe(false);
    });

    it('allows standing near the bottom of the open workspace', () => {
      expect(collidesWithFurniture(18, 88, FLOOR)).toBe(false);
      expect(collidesWithFurniture(80, 80, FLOOR)).toBe(false);
      expect(collidesWithFurniture(50, 90, FLOOR)).toBe(false);
    });
  });

  describe('furniture blocks movement', () => {
    it('blocks the meeting table', () => {
      expect(collidesWithFurniture(18, 18, FLOOR)).toBe(true);
    });

    it('blocks the focus zone desks', () => {
      expect(collidesWithFurniture(42.5, 11.4, FLOOR)).toBe(true);
      expect(collidesWithFurniture(50.3, 11.4, FLOOR)).toBe(true);
    });

    it('blocks the lounge sofas', () => {
      expect(collidesWithFurniture(74.8, 11.4, FLOOR)).toBe(true);
      expect(collidesWithFurniture(88.6, 11.4, FLOOR)).toBe(true);
    });

    it('blocks the open workspace desks', () => {
      expect(collidesWithFurniture(15.81, 52.5, FLOOR)).toBe(true);
      expect(collidesWithFurniture(34.11, 78.19, FLOOR)).toBe(true);
      expect(collidesWithFurniture(51.8, 52.5, FLOOR)).toBe(true);
    });

    it('every declared furniture rectangle is detected at its centre', () => {
      for (const rect of FURNITURE) {
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        expect(
          collidesWithFurniture(cx, cy, FLOOR),
          `${rect.id} centre should block movement`,
        ).toBe(true);
      }
    });
  });

  describe('corridors between furniture', () => {
    it('can pass between the two lounge sofas', () => {
      // sofa-one right edge 79.0%, sofa-two left edge 84.4% -> a 5.4% (48.6px)
      // corridor, wider than the 40px avatar.
      expect(collidesWithFurniture(81.7, 11.4, FLOOR)).toBe(false);
    });

    it('can move vertically between the two desk rows in the open workspace', () => {
      // Top row ends y55.67%, bottom row starts y75.05%.
      expect(collidesWithFurniture(18, 63, FLOOR)).toBe(false);
    });

    it('can cross between the open workspace and the quiet studio', () => {
      // Open workspace ends x64%, quiet studio starts x68%.
      expect(collidesWithFurniture(66, 50, FLOOR)).toBe(false);
    });

    it('can walk above the meeting table inside the meeting room', () => {
      // Meeting table occupies y13.86%–22.85%; above it is free.
      expect(collidesWithFurniture(18, 9, FLOOR)).toBe(false);
    });
  });

  describe('sliding around obstacles', () => {
    it('slides up to the meeting table from the left', () => {
      const result = walk(point(6, 17.3), point(20, 17.3));
      expect(result.x).toBeGreaterThan(6);
      expect(result.x).toBeLessThan(10.8);
      expect(result.y).toBe(17.3);
    });

    it('stops above the meeting table when pushing straight down', () => {
      const result = walk(point(18, 6), point(18, 20));
      expect(result.x).toBe(18);
      expect(result.y).toBeGreaterThan(6);
      expect(result.y).toBeLessThan(13.86);
    });

    it('stops below an open workspace desk when pushing straight up', () => {
      const result = walk(point(15.8, 88), point(15.8, 78.19));
      expect(result.y).toBeGreaterThan(81.32);
      expect(result.y).toBeLessThan(88);
    });

    it('stops to the right of a sofa when pushing left', () => {
      const result = walk(point(97, 11.4), point(74.8, 11.4));
      expect(result.x).toBeGreaterThan(92.8);
      expect(result.x).toBeLessThan(97);
    });

    it('does not get stuck when sliding diagonally into the meeting table', () => {
      const result = walk(point(6, 6), point(20, 20));
      // X advance is unobstructed above the table; Y stops at the table edge.
      expect(result.x).toBeGreaterThan(6);
      expect(result.y).toBeGreaterThan(6);
      expect(result.y).toBeLessThan(13.86);
    });

    it('slides along a wall instead of sticking', () => {
      const start = point(6, 6);
      const first = walk(start, point(20, 6));
      const second = walk(first, point(20, 20));
      expect(second.x).toBe(first.x);
      expect(second.y).toBeGreaterThan(first.y);
    });
  });

  describe('floor boundaries', () => {
    it('keeps the avatar inside the floor on each edge', () => {
      const left = clampToFloorBoundaries(0, 50, FLOOR);
      const right = clampToFloorBoundaries(100, 50, FLOOR);
      const top = clampToFloorBoundaries(50, 0, FLOOR);
      const bottom = clampToFloorBoundaries(50, 100, FLOOR);

      expect(left.x).toBeGreaterThan(0);
      expect(right.x).toBeLessThan(100);
      expect(top.y).toBeGreaterThan(0);
      expect(bottom.y).toBeLessThan(100);
      // The clamped positions must themselves be free of furniture.
      expect(collidesWithFurniture(left.x, left.y, FLOOR)).toBe(false);
      expect(collidesWithFurniture(right.x, right.y, FLOOR)).toBe(false);
      expect(collidesWithFurniture(top.x, top.y, FLOOR)).toBe(false);
      expect(collidesWithFurniture(bottom.x, bottom.y, FLOOR)).toBe(false);
    });

    it('can travel along the left boundary past the furniture', () => {
      const edgeX = clampToFloorBoundaries(0, 50, FLOOR).x;
      expect(collidesWithFurniture(edgeX, 20, FLOOR)).toBe(false);
      expect(collidesWithFurniture(edgeX, 50, FLOOR)).toBe(false);
      expect(collidesWithFurniture(edgeX, 80, FLOOR)).toBe(false);
    });

    it('can travel along the right boundary past the furniture', () => {
      const edgeX = clampToFloorBoundaries(100, 50, FLOOR).x;
      expect(collidesWithFurniture(edgeX, 20, FLOOR)).toBe(false);
      expect(collidesWithFurniture(edgeX, 50, FLOOR)).toBe(false);
      expect(collidesWithFurniture(edgeX, 80, FLOOR)).toBe(false);
    });

    it('can travel along the top and bottom boundaries', () => {
      const topY = clampToFloorBoundaries(50, 0, FLOOR).y;
      const bottomY = clampToFloorBoundaries(50, 100, FLOOR).y;
      expect(collidesWithFurniture(35, topY, FLOOR)).toBe(false);
      expect(collidesWithFurniture(50, topY, FLOOR)).toBe(false);
      expect(collidesWithFurniture(50, bottomY, FLOOR)).toBe(false);
      expect(collidesWithFurniture(80, bottomY, FLOOR)).toBe(false);
    });
  });

  describe('different floor aspect ratios', () => {
    it('keeps a constant pixel radius regardless of floor size', () => {
      const wide = { floorWidth: 900, floorHeight: 540 };
      const narrow = { floorWidth: 400, floorHeight: 540 };
      // A fixed 20px radius is a different percentage on each floor.
      const nearTable = (xPct, opts) => collidesWithFurniture(xPct, 14, opts);
      expect(nearTable(7, wide)).toBe(false);
      expect(nearTable(7, narrow)).toBe(true);
      expect(AVATAR_RADIUS_PX).toBe(20);
    });

    it('still resolves movement correctly on a narrow floor', () => {
      const narrow = { floorWidth: 400, floorHeight: 540 };
      const clamped = clampToFloorBoundaries(0, 0, narrow);
      expect(clamped.x).toBeCloseTo(((AVATAR_RADIUS_PX + 2) / 400) * 100, 6);
      expect(collidesWithFurniture(clamped.x, clamped.y, narrow)).toBe(false);
    });
  });
});
