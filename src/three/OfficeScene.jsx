// The rendered 3D office.
//
// Real geometry through Three.js (via React Three Fiber): a floor, perimeter
// walls, colour-coded zones, desks with monitors and chairs, a meeting table, a
// lounge, plants, a water cooler, lit avatars with shadows, and a perspective
// camera with orbit controls.
//
// Movement runs in `useFrame` with delta-time, through the same percentage-space
// collision model the rest of the app uses. Local position is kept in a ref and
// rendered directly; the React roster is updated at ~10 Hz so the network, the
// proximity mix and the sidebar all see the same coordinates without a 60 fps
// state churn.
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Html, OrbitControls } from '@react-three/drei'
import { DoubleSide } from 'three'
import { findNearestFreePosition } from '../utils/collision.js'
import {
  EARSHOT_WORLD_RADIUS,
  FURNITURE_3D,
  ROOMS_3D,
  WALLS,
  WORLD_DEPTH,
  WORLD_WIDTH,
  directionFromKeys,
  percentToWorld,
  stepAvatar,
  stepToward,
  worldToPercent,
} from './world.js'

const ROOM_TINT = {
  meeting: '#123448',
  focus: '#133a4c',
  lounge: '#143c3f',
  open: '#0f2b3b',
  studio: '#123249',
}

const FURNITURE_TINT = {
  desk: '#2f586c',
  meeting: '#376a80',
  sofa: '#33685d',
}

function RoomZone({ room }) {
  return (
    <group>
      <mesh
        rotation-x={-Math.PI / 2}
        position={[room.centerX, 0.012, room.centerZ]}
        receiveShadow
      >
        <planeGeometry args={[room.width - 0.5, room.depth - 0.5]} />
        <meshStandardMaterial color={ROOM_TINT[room.id] || '#123042'} roughness={0.95} metalness={0.02} />
      </mesh>
      <Html
        position={[room.centerX, 0.25, room.centerZ]}
        center
        distanceFactor={40}
        zIndexRange={[5, 0]}
        style={{ pointerEvents: 'none', userSelect: 'none' }}
      >
        <span className="whitespace-nowrap rounded-md border border-white/10 bg-[#081a27]/80 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-[.18em] text-slate-300">
          {room.label}
        </span>
      </Html>
    </group>
  )
}

function Chair({ position = [0, 0, 0], rotation = [0, 0, 0] }) {
  return (
    <group position={position} rotation={rotation}>
      <mesh castShadow position={[0, 0.52, 0]}>
        <boxGeometry args={[1.15, 0.16, 1.15]} />
        <meshStandardMaterial color="#1d3d4d" roughness={0.8} />
      </mesh>
      <mesh castShadow position={[0, 0.95, -0.5]}>
        <boxGeometry args={[1.15, 1, 0.16]} />
        <meshStandardMaterial color="#22495b" roughness={0.8} />
      </mesh>
      <mesh castShadow position={[0, 0.26, 0]}>
        <cylinderGeometry args={[0.09, 0.09, 0.52, 8]} />
        <meshStandardMaterial color="#16303d" roughness={0.7} />
      </mesh>
    </group>
  )
}

function Desk({ item }) {
  const { centerX, centerZ, width, depth, height } = item
  const legOffsetX = Math.max(0.4, width / 2 - 0.45)
  const legOffsetZ = Math.max(0.3, depth / 2 - 0.3)

  return (
    <group position={[centerX, 0, centerZ]}>
      <mesh castShadow receiveShadow position={[0, height - 0.11, 0]}>
        <boxGeometry args={[width, 0.22, depth]} />
        <meshStandardMaterial color={FURNITURE_TINT.desk} roughness={0.55} metalness={0.08} />
      </mesh>
      {[-1, 1].flatMap((xSign) =>
        [-1, 1].map((zSign) => (
          <mesh
            key={`${xSign}-${zSign}`}
            castShadow
            position={[xSign * legOffsetX, (height - 0.22) / 2, zSign * legOffsetZ]}
          >
            <boxGeometry args={[0.16, height - 0.22, 0.16]} />
            <meshStandardMaterial color="#1c3c4b" roughness={0.8} />
          </mesh>
        )),
      )}
      {/* Monitor */}
      <mesh castShadow position={[0, height + 0.5, -depth * 0.18]}>
        <boxGeometry args={[Math.min(2.1, width * 0.42), 1.15, 0.12]} />
        <meshStandardMaterial color="#0b1c26" roughness={0.4} />
      </mesh>
      <mesh position={[0, height + 0.5, -depth * 0.18 + 0.07]}>
        <boxGeometry args={[Math.min(1.9, width * 0.38), 0.95, 0.02]} />
        <meshStandardMaterial color="#1c6470" emissive="#14505a" emissiveIntensity={0.55} />
      </mesh>
      <mesh castShadow position={[0, height + 0.16, -depth * 0.18]}>
        <boxGeometry args={[0.18, 0.42, 0.16]} />
        <meshStandardMaterial color="#1c3c4b" />
      </mesh>
      <Chair position={[0, 0, depth / 2 + 0.85]} rotation={[0, Math.PI, 0]} />
    </group>
  )
}

function MeetingTable({ item }) {
  const { centerX, centerZ, width, depth, height } = item
  const chairOffset = depth / 2 + 1.1

  return (
    <group position={[centerX, 0, centerZ]}>
      <mesh castShadow receiveShadow position={[0, height - 0.12, 0]}>
        <boxGeometry args={[width, 0.24, depth]} />
        <meshStandardMaterial color={FURNITURE_TINT.meeting} roughness={0.5} metalness={0.1} />
      </mesh>
      {[-1, 1].flatMap((xSign) =>
        [-1, 1].map((zSign) => (
          <mesh
            key={`${xSign}-${zSign}`}
            castShadow
            position={[xSign * (width / 2 - 0.8), (height - 0.24) / 2, zSign * (depth / 2 - 0.8)]}
          >
            <boxGeometry args={[0.2, height - 0.24, 0.2]} />
            <meshStandardMaterial color="#1c3c4b" />
          </mesh>
        )),
      )}
      <Chair position={[-width * 0.22, 0, chairOffset]} />
      <Chair position={[width * 0.22, 0, chairOffset]} />
      <Chair position={[-width * 0.22, 0, -chairOffset]} rotation={[0, Math.PI, 0]} />
      <Chair position={[width * 0.22, 0, -chairOffset]} rotation={[0, Math.PI, 0]} />
    </group>
  )
}

function Sofa({ item }) {
  const { centerX, centerZ, width, depth } = item
  return (
    <group position={[centerX, 0, centerZ]}>
      <mesh castShadow receiveShadow position={[0, 0.42, 0]}>
        <boxGeometry args={[width, 0.5, depth]} />
        <meshStandardMaterial color={FURNITURE_TINT.sofa} roughness={0.9} />
      </mesh>
      <mesh castShadow position={[0, 0.95, depth / 2 - 0.3]}>
        <boxGeometry args={[width, 0.7, 0.4]} />
        <meshStandardMaterial color="#2c5a50" roughness={0.9} />
      </mesh>
      {[-1, 1].map((sign) => (
        <mesh key={sign} castShadow position={[sign * (width / 2 - 0.22), 0.72, 0]}>
          <boxGeometry args={[0.38, 0.45, depth]} />
          <meshStandardMaterial color="#2c5a50" roughness={0.9} />
        </mesh>
      ))}
    </group>
  )
}

function Furniture({ item }) {
  if (item.kind === 'sofa') return <Sofa item={item} />
  if (item.kind === 'meeting') return <MeetingTable item={item} />
  return <Desk item={item} />
}

function Plant({ position, scale = 1 }) {
  return (
    <group position={position} scale={scale}>
      <mesh castShadow position={[0, 0.35, 0]}>
        <cylinderGeometry args={[0.32, 0.24, 0.7, 10]} />
        <meshStandardMaterial color="#284b52" roughness={0.9} />
      </mesh>
      <mesh castShadow position={[0, 1.15, 0]}>
        <sphereGeometry args={[0.62, 12, 10]} />
        <meshStandardMaterial color="#2f7d63" roughness={0.95} />
      </mesh>
      <mesh castShadow position={[0.3, 1.55, 0.1]}>
        <sphereGeometry args={[0.4, 10, 8]} />
        <meshStandardMaterial color="#3d9374" roughness={0.95} />
      </mesh>
    </group>
  )
}

function WaterCooler() {
  return (
    <group position={[28, 0, 8]}>
      <mesh castShadow position={[0, 0.7, 0]}>
        <boxGeometry args={[0.7, 1.4, 0.6]} />
        <meshStandardMaterial color="#2a4c58" roughness={0.7} />
      </mesh>
      <mesh castShadow position={[0, 1.72, 0]}>
        <cylinderGeometry args={[0.3, 0.3, 0.6, 14]} />
        <meshStandardMaterial color="#5fb6c9" transparent opacity={0.85} roughness={0.2} />
      </mesh>
    </group>
  )
}

function AvatarBody({ color, speaking, isSelf, muted, name, emoji, simulated = false, mutedLabel = 'Muted' }) {
  return (
    <group>
      <mesh castShadow receiveShadow position={[0, 0.95, 0]}>
        <capsuleGeometry args={[0.42, 0.85, 6, 14]} />
        <meshStandardMaterial color={color || '#d9f5e9'} roughness={0.65} />
      </mesh>
      <mesh castShadow position={[0, 1.86, 0]}>
        <sphereGeometry args={[0.4, 18, 16]} />
        <meshStandardMaterial color="#f0cdb8" roughness={0.7} />
      </mesh>
      <mesh castShadow position={[0, 2.08, -0.04]}>
        <sphereGeometry args={[0.36, 16, 12]} />
        <meshStandardMaterial color="#2b2b2b" roughness={1} />
      </mesh>
      {isSelf && (
        <mesh rotation-x={-Math.PI / 2} position={[0, 0.03, 0]}>
          <ringGeometry args={[0.72, 0.95, 40]} />
          <meshBasicMaterial color="#45e0c0" transparent opacity={0.85} side={DoubleSide} />
        </mesh>
      )}
      {speaking && (
        <mesh rotation-x={-Math.PI / 2} position={[0, 0.05, 0]}>
          <ringGeometry args={[1.05, 1.32, 40]} />
          <meshBasicMaterial color="#fb7185" transparent opacity={0.7} side={DoubleSide} />
        </mesh>
      )}
      <Html
        position={[0, 2.75, 0]}
        center
        distanceFactor={22}
        zIndexRange={[10, 0]}
        style={{ pointerEvents: 'none', userSelect: 'none' }}
      >
        <div className="flex -translate-y-1 flex-col items-center gap-1">
          <span className="whitespace-nowrap rounded-md border border-white/15 bg-[#081a27]/90 px-2 py-0.5 text-[10px] font-bold text-white shadow">
            {emoji ? <span aria-hidden="true">{emoji} </span> : null}
            {name}
            {isSelf ? <span className="ml-1 text-mint">(you)</span> : null}
            {simulated ? <span className="ml-1 text-slate-400">· demo</span> : null}
          </span>
          {(speaking || muted) && (
            <span
              className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[9px] font-bold ${
                muted ? 'bg-rose-500/20 text-rose-200' : 'bg-emerald-500/20 text-emerald-200'
              }`}
            >
              {muted ? mutedLabel : 'speaking'}
            </span>
          )}
        </div>
      </Html>
    </group>
  )
}

function RemoteAvatar({ person }) {
  const groupRef = useRef(null)
  const target = useMemo(() => percentToWorld(person.x, person.y), [person.x, person.y])

  useFrame((_, rawDelta) => {
    if (!groupRef.current) return
    const k = Math.min(1, Math.max(0, rawDelta) * 9)
    groupRef.current.position.x += (target[0] - groupRef.current.position.x) * k
    groupRef.current.position.z += (target[2] - groupRef.current.position.z) * k
  })

  return (
    <group ref={groupRef} position={target}>
      <AvatarBody
        color={person.color}
        name={person.name}
        emoji={person.emoji}
        simulated={Boolean(person.simulated)}
        speaking={Boolean(person.speaking) && person.online !== false}
      />
    </group>
  )
}

function LocalAvatar({ me, keysRef, targetRef, onSync, muted }) {
  const groupRef = useRef(null)
  const positionRef = useRef({ x: me.x, y: me.y })
  const lastReportedRef = useRef({ x: me.x, y: me.y })
  const lastSyncTimeRef = useRef(0)
  const initial = useMemo(() => percentToWorld(me.x, me.y), []) // eslint-disable-line react-hooks/exhaustive-deps

  // Follow a programmatic reset / restore (large jump), but ignore the small
  // echoes of our own 10 Hz sync.
  useEffect(() => {
    const dx = me.x - positionRef.current.x
    const dy = me.y - positionRef.current.y
    if (Math.hypot(dx, dy) > 2.5) {
      positionRef.current = { x: me.x, y: me.y }
      lastReportedRef.current = { x: me.x, y: me.y }
      targetRef.current = null
      if (groupRef.current) {
        const [wx, , wz] = percentToWorld(me.x, me.y)
        groupRef.current.position.x = wx
        groupRef.current.position.z = wz
      }
    }
  }, [me.x, me.y, targetRef])

  // Credential-free, read-only diagnostic hook (same pattern as
  // window.__proxispeakWebrtc). Browser tests use it to prove the rendered
  // avatar actually moves; it exposes one position and nothing else.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    window.__proxispeakScene = {
      ready: true,
      getLocalPosition: () => ({ x: positionRef.current.x, y: positionRef.current.y }),
    }
    return () => {
      delete window.__proxispeakScene
    }
  }, [])

  useFrame((state, rawDelta) => {
    if (!groupRef.current) return
    // Clamp the frame delta so a backgrounded tab returning after seconds does
    // not teleport the avatar across furniture.
    const delta = Math.min(0.1, Math.max(0, rawDelta))

    const direction = directionFromKeys(keysRef.current)
    let next

    if (direction.x !== 0 || direction.y !== 0) {
      targetRef.current = null
      next = stepAvatar(positionRef.current, direction, delta)
    } else if (targetRef.current) {
      next = stepToward(positionRef.current, targetRef.current, delta)
      if (next.arrived) targetRef.current = null
    } else {
      next = positionRef.current
    }

    if (next.x !== positionRef.current.x || next.y !== positionRef.current.y) {
      positionRef.current = { x: next.x, y: next.y }
      const [wx, , wz] = percentToWorld(next.x, next.y)
      groupRef.current.position.x = wx
      groupRef.current.position.z = wz
    }

    const now = state.clock.elapsedTime
    const last = lastReportedRef.current
    if (
      now - lastSyncTimeRef.current >= 0.1 &&
      (Math.abs(positionRef.current.x - last.x) > 0.001 || Math.abs(positionRef.current.y - last.y) > 0.001)
    ) {
      lastSyncTimeRef.current = now
      lastReportedRef.current = { ...positionRef.current }
      onSync(positionRef.current)
    }
  })

  return (
    <group ref={groupRef} position={initial}>
      {/* Earshot: the same 100 px radius as the proximity audio mix. */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.02, 0]} renderOrder={1}>
        <ringGeometry args={[EARSHOT_WORLD_RADIUS - 0.08, EARSHOT_WORLD_RADIUS, 72]} />
        <meshBasicMaterial color="#45e0c0" transparent opacity={0.4} side={DoubleSide} depthWrite={false} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.015, 0]}>
        <circleGeometry args={[EARSHOT_WORLD_RADIUS, 64]} />
        <meshBasicMaterial color="#45e0c0" transparent opacity={0.05} depthWrite={false} />
      </mesh>
      <AvatarBody
        color={me.color}
        name={me.name}
        emoji={me.emoji}
        isSelf
        speaking={Boolean(me.speaking)}
        muted={muted}
      />
    </group>
  )
}

function FloorClickCatcher({ targetRef }) {
  return (
    <mesh
      rotation-x={-Math.PI / 2}
      position={[0, 0.03, 0]}
      receiveShadow
      onClick={(event) => {
        event.stopPropagation()
        const { x, z } = event.point
        const percent = worldToPercent(x, z)
        // Never walk at a point inside furniture: snap the destination to the
        // nearest free floor so the avatar arrives instead of pushing forever.
        targetRef.current = findNearestFreePosition(percent.x, percent.y, {
          floorWidth: 900,
          floorHeight: 540,
          radiusPx: 20,
        })
      }}
      onPointerOver={() => {
        document.body.style.cursor = 'crosshair'
      }}
      onPointerOut={() => {
        document.body.style.cursor = ''
      }}
    >
      <planeGeometry args={[WORLD_WIDTH, WORLD_DEPTH]} />
      <meshStandardMaterial color="#0b2230" roughness={0.95} metalness={0.03} />
    </mesh>
  )
}

function OfficeLights() {
  return (
    <>
      <ambientLight intensity={0.55} />
      <hemisphereLight args={['#bcd8e6', '#0a1a24', 0.5]} />
      <directionalLight
        position={[26, 42, 22]}
        intensity={1.55}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-left={-60}
        shadow-camera-right={60}
        shadow-camera-top={40}
        shadow-camera-bottom={-40}
        shadow-camera-near={1}
        shadow-camera-far={140}
        shadow-bias={-0.0006}
      />
      <pointLight position={[-24, 12, -8]} intensity={0.35} color="#7fd8e8" />
    </>
  )
}

function SceneContents({ people, me, keysRef, onSync, muted }) {
  const targetRef = useRef(null)
  const gl = useThree((state) => state.gl)
  const onSyncRef = useRef(onSync)
  onSyncRef.current = onSync

  const handleSync = useCallback(
    (position) => {
      onSyncRef.current?.(position)
    },
    [],
  )

  useEffect(() => {
    const canvas = gl.domElement
    const handleLost = (event) => {
      event.preventDefault()
      window.dispatchEvent(new CustomEvent('proxispeak:webgl-lost'))
    }
    canvas.addEventListener('webglcontextlost', handleLost)
    return () => canvas.removeEventListener('webglcontextlost', handleLost)
  }, [gl])

  const others = people.filter((person) => !person.you && person.online !== false)

  return (
    <>
      <color attach="background" args={['#07131c']} />
      <fog attach="fog" args={['#07131c', 78, 150]} />
      <OfficeLights />

      <FloorClickCatcher targetRef={targetRef} />
      <gridHelper args={[100, 50, '#20465a', '#14303f']} position={[0, 0.035, 0]} />

      <mesh receiveShadow position={[0, -0.3, 0]}>
        <boxGeometry args={[WORLD_WIDTH, 0.6, WORLD_DEPTH]} />
        <meshStandardMaterial color="#0a1e29" roughness={0.95} />
      </mesh>

      {WALLS.map((wall) => (
        <mesh key={wall.id} position={wall.position} castShadow receiveShadow>
          <boxGeometry args={wall.size} />
          <meshStandardMaterial color="#173747" roughness={0.85} />
        </mesh>
      ))}

      {ROOMS_3D.map((room) => (
        <RoomZone key={room.id} room={room} />
      ))}

      {FURNITURE_3D.map((item) => (
        <Furniture key={item.id} item={item} />
      ))}

      <Plant position={[-27, 0, -25]} />
      <Plant position={[28, 0, -24]} scale={0.85} />
      <Plant position={[-34, 0, 12]} scale={0.9} />
      <WaterCooler />

      {others.map((person) => (
        <RemoteAvatar key={person.id} person={person} />
      ))}

      {me && (
        <LocalAvatar
          me={me}
          keysRef={keysRef}
          targetRef={targetRef}
          onSync={handleSync}
          muted={muted}
        />
      )}

      <OrbitControls
        makeDefault
        enablePan={false}
        enableDamping
        dampingFactor={0.08}
        minDistance={20}
        maxDistance={95}
        minPolarAngle={0.25}
        maxPolarAngle={1.28}
        target={[0, 0, 0]}
      />
    </>
  )
}

export default function OfficeScene({ people, me, keysRef, onSync, muted = false }) {
  return (
    <Canvas
      shadows
      dpr={[1, 1.75]}
      camera={{ position: [0, 44, 52], fov: 40, near: 0.1, far: 220 }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      className="touch-none"
      aria-label="Three-dimensional virtual office. Use WASD or arrow keys to walk, or click the floor to move."
    >
      <SceneContents people={people} me={me} keysRef={keysRef} onSync={onSync} muted={muted} />
    </Canvas>
  )
}

