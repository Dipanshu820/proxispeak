// Shared collision model for ProxiSpeak's virtual office floor.
//
// This module is the single source of truth for:
//   1. Probability/math helpers used by the proximity UI (distance, strength).
//   2. The office layout geometry (rooms + the furniture inside them).
//   3. Collision and movement resolution.
//
// Both the React component (src/pages/VirtualOffice.jsx) and the unit tests
// import from here, so the geometry that is drawn on screen and the geometry
// that blocks the avatar can never drift apart.
//
// Coordinate conventions
// ----------------------
// - Room rectangles are percentages of the FLOOR container (matching CSS
//   `left/top/width/height` on `.room-*`).
// - Furniture rectangles are percentages of their PARENT ROOM (matching the
//   CSS offsets on `.desk-*`, `.sofa-*` and `.meeting-table`). This is the
//   coordinate space the browser actually renders them in.
// - Avatar positions are percentages of the FLOOR container.
// - Collision itself is evaluated in PIXELS, because the rendered avatar is a
//   fixed 40px circle while a percentage is not a length. Converting to pixels
//   is the only way the avatar keeps a consistent physical footprint on floors
//   of different sizes and aspect ratios.

export const EARSHOT_RADIUS_PX = 100;

export function pctToPixels(pctX, pctY, floorWidth, floorHeight) {
  return {
    x: (pctX / 100) * floorWidth,
    y: (pctY / 100) * floorHeight,
  };
}

export function pixelDistance(personA, personB, floorWidth, floorHeight) {
  const posA = pctToPixels(personA.x, personA.y, floorWidth, floorHeight);
  const posB = pctToPixels(personB.x, personB.y, floorWidth, floorHeight);
  return Math.hypot(posA.x - posB.x, posA.y - posB.y);
}

export function proximityStrength(distancePx) {
  if (distancePx <= 0) return 100;
  if (distancePx >= EARSHOT_RADIUS_PX) return 0;
  return Math.max(0, 100 * (1 - distancePx / EARSHOT_RADIUS_PX));
}

export function isWithinEarshot(distancePx) {
  return distancePx <= EARSHOT_RADIUS_PX;
}

// ---------------------------------------------------------------------------
// Rendered avatar size
// ---------------------------------------------------------------------------
// The avatar body in the component is:
//     <div class="h-10 w-10 rounded-full border-[3px] ...">   (the emoji circle)
// Tailwind Preflight sets `box-sizing: border-box`, so `h-10 w-10` is the full
// outer size of the circle: 40px x 40px *including* the 3px border.
// The collision footprint is therefore a circle of diameter 40px -> radius 20px.
//
// The collision radius is a true pixel radius and deliberately has NO extra
// "padding" fudge factor: the avatar is allowed to touch furniture exactly when
// its visible circle touches it. Because every collision check converts the
// percentage coordinates to pixels first, this radius stays physically correct
// on any floor size or aspect ratio.

export const AVATAR_DIAMETER_PX = 40;
export const AVATAR_RADIUS_PX = AVATAR_DIAMETER_PX / 2; // 20px

// A representative floor size used when a caller does not pass real pixel
// dimensions (e.g. pure unit tests). 540px matches `.office-floor` height at
// the desktop breakpoint; 900px is a representative width of the floor panel.
export const DEFAULT_FLOOR = { width: 900, height: 540 };

// ---------------------------------------------------------------------------
// Office layout (single source of truth for rooms + furniture)
// ---------------------------------------------------------------------------
// Room x/y/w/h are floor percentages; furniture x/y/w/h are percentages of the
// room they live in, mirroring the CSS declarations in src/styles.css.

const DESKS_OPEN_WORKSPACE = ['a', 'b', 'c', 'd', 'e', 'f'].map((k, i) => ({
  id: `open-desk-${k}`,
  kind: 'desk',
  className: 'table desk',
  // a/b/c sit on the top row, d/e/f on the bottom row (same columns).
  x: [9, 39, 68][i % 3],
  y: i < 3 ? 20 : 65,
  w: 24,
  h: 11,
}));

export const OFFICE_LAYOUT = {
  rooms: [
    {
      id: 'meeting',
      label: 'Meeting room',
      className: 'room-meeting',
      x: 3,
      y: 4,
      w: 30,
      h: 29,
      furniture: [
        { id: 'meeting-table', kind: 'meeting', className: 'table meeting-table', x: 26, y: 34, w: 48, h: 31 },
      ],
    },
    {
      id: 'focus',
      label: 'Focus zone',
      className: 'room-focus',
      x: 37,
      y: 4,
      w: 26,
      h: 29,
      furniture: [
        { id: 'focus-desk-a', kind: 'desk', className: 'table desk', x: 9, y: 20, w: 24, h: 11 },
        { id: 'focus-desk-b', kind: 'desk', className: 'table desk', x: 39, y: 20, w: 24, h: 11 },
      ],
    },
    {
      id: 'lounge',
      label: 'Lounge',
      className: 'room-lounge',
      x: 67,
      y: 4,
      w: 30,
      h: 29,
      furniture: [
        { id: 'sofa-one', kind: 'sofa', className: 'sofa', x: 12, y: 17, w: 28, h: 17 },
        { id: 'sofa-two', kind: 'sofa', className: 'sofa', x: 58, y: 17, w: 28, h: 17, style: { background: '#a4b9d1', borderColor: '#7c9cb9' } },
      ],
    },
    {
      id: 'open',
      label: 'Open workspace',
      className: 'room-open',
      x: 3,
      y: 38,
      w: 61,
      h: 57,
      furniture: DESKS_OPEN_WORKSPACE,
    },
    {
      id: 'studio',
      label: 'Quiet studio',
      className: 'room-studio',
      x: 68,
      y: 38,
      w: 29,
      h: 57,
      furniture: [
        { id: 'studio-desk-a', kind: 'desk', className: 'table desk', x: 9, y: 20, w: 24, h: 11 },
        { id: 'studio-desk-d', kind: 'desk', className: 'table desk', x: 9, y: 65, w: 24, h: 11 },
      ],
    },
  ],
};

// Convert a furniture item (percentage of its room) into floor percentages.
export function furnitureToFloorRect(room, item) {
  return {
    x: room.x + (item.x / 100) * room.w,
    y: room.y + (item.y / 100) * room.h,
    w: (item.w / 100) * room.w,
    h: (item.h / 100) * room.h,
  };
}

// Every solid piece of furniture, expressed in floor percentages.
// Rooms themselves are only containers and are never collidable.
export const FURNITURE = OFFICE_LAYOUT.rooms.flatMap((room) =>
  room.furniture.map((item) => ({
    id: item.id,
    kind: item.kind,
    className: item.className,
    roomId: room.id,
    ...furnitureToFloorRect(room, item),
  })),
);

// Plain rectangle list (floor percentages) consumed by the collision check.
export const FURNITURE_RECTS = FURNITURE.map(
  ({ id, kind, className, roomId, ...rect }) => rect,
);

export function getFurnitureRects() {
  return FURNITURE_RECTS;
}

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

function resolveOptions(options) {
  const {
    floorWidth = DEFAULT_FLOOR.width,
    floorHeight = DEFAULT_FLOOR.height,
    radiusPx = AVATAR_RADIUS_PX,
  } = options || {};
  return { floorWidth, floorHeight, radiusPx };
}

// Circle (avatar) vs rectangles (furniture), evaluated in pixels.
// `collidesWithFurniture(xPercent, yPercent, options)`
export function collidesWithFurniture(xPct, yPct, options) {
  const { floorWidth, floorHeight, radiusPx } = resolveOptions(options);
  const px = (xPct / 100) * floorWidth;
  const py = (yPct / 100) * floorHeight;
  const r2 = radiusPx * radiusPx;

  for (const rect of FURNITURE_RECTS) {
    const left = (rect.x / 100) * floorWidth;
    const right = ((rect.x + rect.w) / 100) * floorWidth;
    const top = (rect.y / 100) * floorHeight;
    const bottom = ((rect.y + rect.h) / 100) * floorHeight;

    const closestX = Math.max(left, Math.min(px, right));
    const closestY = Math.max(top, Math.min(py, bottom));
    const dx = px - closestX;
    const dy = py - closestY;

    if (dx * dx + dy * dy <= r2) {
      return true;
    }
  }

  return false;
}

const SLIDE_STEP_PCT = 0.05;

// Advance from `from` towards `to` along one axis, stopping at the last free
// position BEFORE the first blocked one. This never tunnels through furniture:
// it always walks outward from the current position and halts on contact.
function slideAxis(from, to, fixed, axis, options) {
  const dir = Math.sign(to - from);
  if (dir === 0) return from;

  const distance = Math.abs(to - from);
  let last = from;

  for (let offset = SLIDE_STEP_PCT; offset <= distance + 1e-9; offset += SLIDE_STEP_PCT) {
    const candidate = from + dir * offset;
    const free =
      axis === 'x'
        ? !collidesWithFurniture(candidate, fixed, options)
        : !collidesWithFurniture(fixed, candidate, options);
    if (!free) break;
    last = candidate;
  }

  return last;
}

// Resolve a movement request, allowing the avatar to slide along furniture and
// floor edges instead of sticking or teleporting.
//
// X is resolved first (sliding if needed), then Y is resolved against the
// already-updated X. This means a diagonal push into a wall still produces
// motion along the free axis, and pure vertical movement works.
//
// If the avatar somehow *starts* inside furniture (a stale saved layout, or a
// drag performed by an older build), it is never trapped: the move is honoured
// whenever its destination is free, and otherwise the avatar snaps out to the
// nearest free position. That recovery path only exists for an already-invalid
// starting state, so it cannot be used to walk through furniture from a valid
// position.
export function resolveCollision(currentX, currentY, newX, newY, options) {
  const opts = resolveOptions(options);

  if (collidesWithFurniture(currentX, currentY, opts)) {
    if (!collidesWithFurniture(newX, newY, opts)) {
      return { x: newX, y: newY };
    }
    return findNearestFreePosition(currentX, currentY, opts);
  }

  let x = currentX;
  let y = currentY;

  // Always walk the axis outward instead of accepting the raw endpoint. That
  // keeps a large single-frame delta (e.g. a pointer drag) from tunnelling
  // through furniture while still allowing fully free movement.
  if (newX !== currentX) {
    x = slideAxis(currentX, newX, y, 'x', opts);
  }

  if (newY !== currentY) {
    y = slideAxis(currentY, newY, x, 'y', opts);
  }

  return { x, y };
}

// ---------------------------------------------------------------------------
// Escape hatch: nearest free floor position
// ---------------------------------------------------------------------------

const FREE_SEARCH_STEP_PCT = 0.5;
const FREE_SEARCH_ANGLES = 16;
const FREE_SEARCH_MAX_PCT = 60;

// Finds the closest position to (xPct, yPct) whose avatar circle does not
// overlap any furniture, staying inside the floor. Returns the input (clamped)
// if no free position is found within the search radius.
export function findNearestFreePosition(xPct, yPct, options) {
  const opts = resolveOptions(options);
  const clamped = clampToFloorBoundaries(xPct, yPct, opts);
  if (!collidesWithFurniture(clamped.x, clamped.y, opts)) return clamped;

  for (let radius = FREE_SEARCH_STEP_PCT; radius <= FREE_SEARCH_MAX_PCT; radius += FREE_SEARCH_STEP_PCT) {
    for (let i = 0; i < FREE_SEARCH_ANGLES; i += 1) {
      const angle = (i / FREE_SEARCH_ANGLES) * Math.PI * 2;
      const candidate = clampToFloorBoundaries(
        clamped.x + Math.cos(angle) * radius,
        clamped.y + Math.sin(angle) * radius,
        opts,
      );
      if (!collidesWithFurniture(candidate.x, candidate.y, opts)) return candidate;
    }
  }

  return clamped;
}

// Keep the avatar's collision circle fully inside the floor panel.
export const FLOOR_EDGE_MARGIN_PX = 2;

export function clampToFloorBoundaries(xPct, yPct, options) {
  const { floorWidth, floorHeight, radiusPx } = resolveOptions(options);
  const marginPx = radiusPx + FLOOR_EDGE_MARGIN_PX;
  const minX = (marginPx / floorWidth) * 100;
  const minY = (marginPx / floorHeight) * 100;

  return {
    x: Math.max(minX, Math.min(100 - minX, xPct)),
    y: Math.max(minY, Math.min(100 - minY, yPct)),
  };
}
