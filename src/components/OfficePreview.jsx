// Static isometric illustration of the real office layout.
//
// The polygons are projected from OFFICE_LAYOUT/FURNITURE — the same rectangles
// the 3D scene and the collision model use — so the marketing preview does not
// drift from the product. It is an illustration (no WebGL, no interaction); the
// live office is the rendered Three.js scene on /office.
import { FURNITURE, OFFICE_LAYOUT } from '../utils/collision.js'
import { INITIAL_PEOPLE } from '../utils/people.js'

const COS30 = Math.cos(Math.PI / 6)
const SIN30 = 0.5
const FLOOR_W = 100
const FLOOR_D = 60

const ROOM_FILL = {
  meeting: '#123247',
  focus: '#13384a',
  lounge: '#14383c',
  open: '#102b3c',
  studio: '#123147',
}

const FURNITURE_FILL = {
  desk: ['#2c5468', '#22485c', '#1b3b4c'],
  meeting: ['#35657b', '#2a566a', '#214656'],
  sofa: ['#2f6157', '#27544b', '#1f463e'],
}

function project(xPercent, yPercent, z = 0) {
  const ux = (xPercent / 100) * FLOOR_W
  const uy = (yPercent / 100) * FLOOR_D
  return {
    x: (ux - uy) * COS30,
    y: (ux + uy) * SIN30 - z,
  }
}

function polygon(points, fill, extra = {}) {
  return (
    <polygon
      points={points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')}
      fill={fill}
      {...extra}
    />
  )
}

function prism(rect, height, fills) {
  const [top, sideA, sideB] = fills
  const base = [
    project(rect.x, rect.y),
    project(rect.x + rect.w, rect.y),
    project(rect.x + rect.w, rect.y + rect.h),
    project(rect.x, rect.y + rect.h),
  ]
  const upper = base.map((point) => ({ x: point.x, y: point.y - height }))

  return (
    <g key={rect.id}>
      {polygon([upper[1], upper[2], base[2], base[1]], sideA)}
      {polygon([upper[2], upper[3], base[3], base[2]], sideB)}
      {polygon(upper, top, { stroke: 'rgba(255,255,255,.06)', strokeWidth: 0.15 })}
    </g>
  )
}

const FURNITURE_HEIGHT = { desk: 3.1, meeting: 3.2, sofa: 3.8 }

export default function OfficePreview({ className = '' }) {
  const rooms = OFFICE_LAYOUT.rooms.map((room) => {
    const corners = [
      project(room.x, room.y),
      project(room.x + room.w, room.y),
      project(room.x + room.w, room.y + room.h),
      project(room.x, room.y + room.h),
    ]
    const label = project(room.x + room.w / 2, room.y + room.h / 2)
    return { room, corners, label }
  })

  const furniture = [...FURNITURE].sort(
    (a, b) => a.x + a.w / 2 + a.y + a.h / 2 - (b.x + b.w / 2 + b.y + b.h / 2),
  )

  const avatars = INITIAL_PEOPLE.filter((person) => person.online).map((person) => {
    const point = project(person.x, person.y, 8.5)
    return { person, point }
  })

  return (
    <svg
      viewBox="-62 -14 158 104"
      role="img"
      aria-label="Isometric illustration of the ProxiSpeak office floor: five colour-coded zones with desks, sofas, a meeting table and colleagues."
      className={className}
    >
      <defs>
        <linearGradient id="ps-floor" x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0%" stopColor="#0d2432" />
          <stop offset="100%" stopColor="#0a1b27" />
        </linearGradient>
      </defs>

      {polygon(
        [
          project(0, 0),
          project(100, 0),
          project(100, 60),
          project(0, 60),
        ],
        'url(#ps-floor)',
        { stroke: '#1d4557', strokeWidth: 1.1 },
      )}

      {rooms.map(({ room, corners, label }) => (
        <g key={room.id}>
          {polygon(corners, ROOM_FILL[room.id] || '#113042', {
            stroke: 'rgba(148, 191, 210, .22)',
            strokeWidth: 0.28,
          })}
          <text
            x={label.x}
            y={label.y}
            fill="rgba(203, 231, 240, .5)"
            fontSize="2.2"
            fontWeight="700"
            textAnchor="middle"
            letterSpacing="0.25"
            style={{ textTransform: 'uppercase' }}
          >
            {room.label}
          </text>
        </g>
      ))}

      {furniture.map((item) =>
        prism(item, FURNITURE_HEIGHT[item.kind] || 3, FURNITURE_FILL[item.kind] || FURNITURE_FILL.desk),
      )}

      {avatars.map(({ person, point }) => (
        <g key={person.id}>
          <ellipse cx={point.x} cy={point.y + 0.9} rx="2.1" ry="0.85" fill="rgba(0,0,0,.35)" />
          <circle cx={point.x} cy={point.y} r="2.15" fill={person.color} stroke={person.you ? '#45e0c0' : '#0b1e2b'} strokeWidth={person.you ? 0.5 : 0.3} />
          <text x={point.x} y={point.y + 0.75} fontSize="1.8" textAnchor="middle" fill="#0b1e2b" fontWeight="800">
            {person.name.slice(0, 1)}
          </text>
        </g>
      ))}
    </svg>
  )
}
