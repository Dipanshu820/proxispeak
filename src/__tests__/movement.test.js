import { describe, it, expect } from 'vitest';
import {
  AVATAR_DIAMETER_PX,
  AVATAR_RADIUS_PX,
  DEFAULT_FLOOR,
  FURNITURE,
  FURNITURE_RECTS,
  OFFICE_LAYOUT,
  clampToFloorBoundaries,
  collidesWithFurniture,
  findNearestFreePosition,
  furnitureToFloorRect,
} from '../utils/collision';
import { resolveCollision } from '../utils/collision';

// Representative desktop floor. 540px matches `.office-floor` at the desktop
// breakpoint; 900px is a representative width of the floor panel.
const FLOOR = { floorWidth: DEFAULT_FLOOR.width, floorHeight: DEFAULT_FLOOR.height };

describe('Avatar collision radius', () => {
  it('is derived from the rendered avatar circle', () => {
    // The avatar body is `h-10 w-10` (40px) with a 3px border included by
    // border-box sizing, so the collision radius is exactly half of it.
    expect(AVATAR_DIAMETER_PX).toBe(40);
    expect(AVATAR_RADIUS_PX).toBe(20);
    expect(AVATAR_RADIUS_PX).toBe(AVATAR_DIAMETER_PX / 2);
  });
});

describe('Shared office layout', () => {
  it('defines the five rooms that are rendered on the floor', () => {
    expect(OFFICE_LAYOUT.rooms.map((r) => r.id)).toEqual([
      'meeting',
      'focus',
      'lounge',
      'open',
      'studio',
    ]);
  });

  it('exposes only solid furniture as collision rectangles', () => {
    expect(FURNITURE).toHaveLength(13);
    expect(FURNITURE_RECTS).toHaveLength(13);
    expect(FURNITURE.map((f) => f.id)).toContain('meeting-table');
    expect(FURNITURE.map((f) => f.id)).toContain('sofa-one');
    expect(FURNITURE.map((f) => f.id)).toContain('open-desk-f');
    expect(FURNITURE.map((f) => f.id)).toContain('studio-desk-d');
  });

  it('converts room-relative furniture offsets into floor percentages', () => {
    const lounge = OFFICE_LAYOUT.rooms.find((r) => r.id === 'lounge');
    const sofaOne = lounge.furniture.find((f) => f.id === 'sofa-one');
    const rect = furnitureToFloorRect(lounge, sofaOne);
    // sofa-one at 12%/17% inside a 30%/29% room anchored at 67%/4%.
    expect(rect.x).toBeCloseTo(70.6, 2);
    expect(rect.y).toBeCloseTo(8.93, 2);
    expect(rect.w).toBeCloseTo(8.4, 2);
    expect(rect.h).toBeCloseTo(4.93, 2);
  });

  it('does not treat room containers as solid obstacles', () => {
    // These points sit inside rooms but not inside any furniture.
    expect(collidesWithFurniture(60, 30, FLOOR)).toBe(false); // focus zone interior
    expect(collidesWithFurniture(60, 60, FLOOR)).toBe(false); // open workspace interior
    expect(collidesWithFurniture(50, 90, FLOOR)).toBe(false); // open workspace, lower edge
  });
});

describe('collidesWithFurniture', () => {
  it('blocks positions inside each kind of furniture', () => {
    expect(collidesWithFurniture(18, 18, FLOOR)).toBe(true); // meeting table
    expect(collidesWithFurniture(21, 25.5, FLOOR)).toBe(true); // meeting table lower edge
    expect(collidesWithFurniture(42.5, 11.4, FLOOR)).toBe(true); // focus desk-a
    expect(collidesWithFurniture(74.8, 11.4, FLOOR)).toBe(true); // sofa-one
    expect(collidesWithFurniture(15.81, 78.19, FLOOR)).toBe(true); // open desk-d
  });

  it('keeps open floor positions reachable', () => {
    expect(collidesWithFurniture(35, 18, FLOOR)).toBe(false); // gap between meeting/focus
    expect(collidesWithFurniture(65, 18, FLOOR)).toBe(false); // gap between focus/lounge
    expect(collidesWithFurniture(18, 35, FLOOR)).toBe(false); // below the meeting room
    expect(collidesWithFurniture(49, 25.5, FLOOR)).toBe(false); // below the top furniture band
    expect(collidesWithFurniture(66, 50, FLOOR)).toBe(false); // gap open workspace/studio
    expect(collidesWithFurniture(18, 60, FLOOR)).toBe(false); // vertical corridor between desk rows
    expect(collidesWithFurniture(50, 90, FLOOR)).toBe(false); // open floor near the bottom
  });

  it('blocks positions that are genuinely covered by visible furniture', () => {
    // (18, 18) is inside the meeting room table; (18, 80) is inside an open
    // workspace desk. These are not "open paths".
    expect(collidesWithFurniture(18, 18, FLOOR)).toBe(true);
    expect(collidesWithFurniture(18, 80, FLOOR)).toBe(true);
  });

  it('is evaluated in pixels so different floor sizes give different results', () => {
    // (7, 14) is just above/left of the meeting table. On a wide floor there is
    // more than 20px of clearance; on a narrow floor the same percentage is
    // within the avatar radius of the table.
    expect(collidesWithFurniture(7, 14, { floorWidth: 900, floorHeight: 540 })).toBe(false);
    expect(collidesWithFurniture(7, 14, { floorWidth: 400, floorHeight: 540 })).toBe(true);
  });

  it('treats a position near a furniture corner correctly', () => {
    // Just outside the meeting table's top-left corner (10.8%, 13.86%).
    expect(collidesWithFurniture(8.8, 11.86, FLOOR)).toBe(false);
    // Just inside the corner.
    expect(collidesWithFurniture(11.5, 14.5, FLOOR)).toBe(true);
  });

  it('honours a custom radius', () => {
    const tiny = { ...FLOOR, radiusPx: 4 };
    // Meeting table top edge is 13.86% (74.84px). A 4px radius leaves clearance
    // at 13.0% but the default 20px radius does not.
    expect(collidesWithFurniture(18, 13.0, tiny)).toBe(false);
    expect(collidesWithFurniture(18, 14.0, tiny)).toBe(true);
    expect(collidesWithFurniture(18, 13.0, FLOOR)).toBe(true);
  });
});

describe('resolveCollision', () => {
  it('moves freely when the destination is clear', () => {
    const result = resolveCollision(-50, -50, -40, -40, FLOOR);
    expect(result.x).toBeCloseTo(-40, 3);
    expect(result.y).toBeCloseTo(-40, 3);
  });

  it('supports pure vertical movement', () => {
    const result = resolveCollision(18, 6, 18, 20, FLOOR);
    // Stops just above the meeting table (top edge 13.86% -> ~10.15% for r=20px).
    expect(result.x).toBe(18);
    expect(result.y).toBeGreaterThan(6);
    expect(result.y).toBeLessThan(13.86);
  });

  it('slides up to the edge instead of sticking when pushing into furniture', () => {
    const result = resolveCollision(6, 17.3, 20, 17.3, FLOOR);
    // The meeting table's left edge is 10.8%; the avatar stops before it.
    expect(result.x).toBeGreaterThan(6);
    expect(result.x).toBeLessThan(10.8);
    expect(result.y).toBe(17.3);
  });

  it('never tunnels through furniture when given a large step', () => {
    const result = resolveCollision(6, 17.3, 30, 17.3, FLOOR);
    expect(result.x).toBeLessThan(10.8);
  });

  it('slides along the free axis when pushing diagonally into an obstacle', () => {
    const result = resolveCollision(6, 6, 20, 20, FLOOR);
    // X can advance fully (above the table), then Y stops at the table's top.
    expect(result.x).toBeCloseTo(20, 3);
    expect(result.y).toBeGreaterThan(6);
    expect(result.y).toBeLessThan(13.86);
  });

  it('does not move when no movement is requested', () => {
    // (49, 25.5) is open floor below the top band of furniture.
    const result = resolveCollision(49, 25.5, 49, 25.5, FLOOR);
    expect(result).toEqual({ x: 49, y: 25.5 });
  });

  it('allows approaching furniture from above without entering it', () => {
    const result = resolveCollision(15.8, 88, 15.8, 78.19, FLOOR);
    // open-desk-d spans 75.05%–81.32%; the avatar must stop below it.
    expect(result.y).toBeGreaterThan(81.32);
    expect(result.y).toBeLessThan(88);
  });

  it('allows approaching furniture from the right without entering it', () => {
    const result = resolveCollision(97, 11.4, 74.8, 11.4, FLOOR);
    // sofa-two spans 84.4%–92.8%; the avatar must stop to its right.
    expect(result.x).toBeGreaterThan(92.8);
    expect(result.x).toBeLessThan(97);
  });

  it('escapes furniture instead of trapping the avatar there forever', () => {
    // (18, 18) is inside the meeting table, which is not a legal position. It
    // can happen with a stale saved layout, so the avatar must be able to leave
    // rather than being permanently stuck.
    const escaped = resolveCollision(18, 18, 18, 10, FLOOR);
    expect(collidesWithFurniture(escaped.x, escaped.y, FLOOR)).toBe(false);

    // Even when the requested destination is still inside the furniture, the
    // avatar snaps out to the nearest free floor position.
    const snapped = resolveCollision(18, 18, 18, 18.5, FLOOR);
    expect(collidesWithFurniture(snapped.x, snapped.y, FLOOR)).toBe(false);
  });

  it('finds the nearest free position around furniture', () => {
    const free = findNearestFreePosition(18, 18, FLOOR);
    expect(collidesWithFurniture(free.x, free.y, FLOOR)).toBe(false);

    // A position that is already free is returned untouched (clamped only).
    expect(findNearestFreePosition(49, 25.5, FLOOR)).toEqual({ x: 49, y: 25.5 });
  });

  it('handles movement exactly at floor boundary', () => {
    const edgeX = clampToFloorBoundaries(0, 50, FLOOR).x;
    const result = resolveCollision(edgeX, 50, edgeX + 1, 50, FLOOR);
    // Should allow small movement away from edge
    expect(result.x).toBeGreaterThan(edgeX);
  });

  it('handles diagonal movement into a corner between furniture', () => {
    // Move diagonally toward the corner between meeting table and focus desks
    const result = resolveCollision(30, 10, 35, 15, FLOOR);
    // Should allow movement if the path is clear
    expect(result.x).toBeGreaterThan(30);
    expect(result.y).toBeGreaterThan(10);
  });
});

describe('clampToFloorBoundaries', () => {
  it('keeps a full avatar inside the floor on every edge', () => {
    const clamped = clampToFloorBoundaries(0, 0, FLOOR);
    const marginX = ((AVATAR_RADIUS_PX + 2) / 900) * 100;
    const marginY = ((AVATAR_RADIUS_PX + 2) / 540) * 100;
    expect(clamped.x).toBeCloseTo(marginX, 6);
    expect(clamped.y).toBeCloseTo(marginY, 6);

    const high = clampToFloorBoundaries(100, 100, FLOOR);
    expect(high.x).toBeCloseTo(100 - marginX, 6);
    expect(high.y).toBeCloseTo(100 - marginY, 6);
  });

  it('leaves valid positions unchanged', () => {
    expect(clampToFloorBoundaries(50, 50, FLOOR)).toEqual({ x: 50, y: 50 });
  });

  it('clamps negative and out-of-range coordinates', () => {
    const result = clampToFloorBoundaries(-10, 150, FLOOR);
    expect(result.x).toBeGreaterThan(0);
    expect(result.y).toBeLessThan(100);
  });
});
