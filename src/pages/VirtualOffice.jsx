import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, LayoutGrid, Users, Mic, Save, RotateCcw, Settings, AudioLines, LogOut } from 'lucide-react'
import { useAuth } from '../auth/AuthContext.jsx'
import { isWebGLAvailable } from '../utils/webgl.js'
import SceneBoundary from '../three/SceneBoundary.jsx'
import {
  EARSHOT_RADIUS_PX,
  AVATAR_RADIUS_PX,
  DEFAULT_FLOOR,
  FURNITURE,
  OFFICE_LAYOUT,
  pixelDistance,
  pctToPixels,
  proximityStrength,
  isWithinEarshot,
  resolveCollision,
  clampToFloorBoundaries,
  findNearestFreePosition,
} from '../utils/collision.js'
import { createInitialPeople } from '../utils/people.js'
import {
  applySavedLayout,
  layoutErrorMessage,
  readSavedLayout,
  saveLayout as persistLayout,
} from '../utils/layout.js'
import {
  connect as connectSocket,
  disconnect as disconnectSocket,
  getSocket,
  isConnected as isSocketConnected,
  joinRoom,
  updatePosition as socketUpdatePosition,
  updateSpeaking as socketUpdateSpeaking,
  on as socketOn,
  off as socketOff,
} from '../utils/socket.js'
import { requestSession, fetchIceServers } from '../utils/auth.js'
import {
  init as initWebRTC,
  destroy as destroyWebRTC,
  configure as configureWebRTC,
  requestMic as requestMicWebRTC,
  releaseMic as releaseMicWebRTC,
  isMicActive as isMicActiveWebRTC,
  initiatePeerConnection,
  updateProximityVolume,
  cleanupPeerConnection,
  cleanupAllPeers,
  getPeerCount,
  getConnectedPeers,
  getPeerDiagnostics,
  getPeerStats,
} from '../utils/webrtc.js'

// Three.js is loaded only when the browser can actually render it. This keeps
// jsdom tests (and locked-down browsers) on the 2D floor without ever importing
// the WebGL stack.
const OfficeScene = lazy(() => import('../three/OfficeScene.jsx'))

// The collision model works in pixels, so every caller needs the measured floor
// size. Before the floor has been measured (first render, jsdom tests) fall back
// to a representative desktop floor.
function collisionOptionsFor(size) {
  const width = size && size.width > 0 ? size.width : DEFAULT_FLOOR.width
  const height = size && size.height > 0 ? size.height : DEFAULT_FLOOR.height
  return { floorWidth: width, floorHeight: height, radiusPx: AVATAR_RADIUS_PX }
}

// The microphone meter is driven straight from the animation frame (a React
// state update 60x/second would re-render the whole office floor), so this
// helper owns both the CSS bar and its ARIA value.
function setMicMeterLevel(percent) {
  const meter = document.getElementById('micmeter')
  if (!meter) return
  meter.style.setProperty('--level', `${percent}%`)
  meter.setAttribute('aria-valuenow', String(Math.round(percent)))
}

export default function VirtualOffice({ onHome, onSettings, onSignedOut }) {
  const { user, logout } = useAuth()
  const [people, setPeople] = useState(createInitialPeople)
  // Real WebGL probe. When it fails (or the scene throws later) the component
  // falls back to the accessible DOM floor instead of a blank canvas.
  const [webglAvailable] = useState(() => isWebGLAvailable())
  const [sceneFailed, setSceneFailed] = useState(false)
  // Explicit, supported fallback: `?renderer=2d` (remembered for the browser
  // session) forces the accessible DOM floor even when WebGL works. This is how
  // the 2D browser suite stays deterministic on machines with software GL.
  const [force2D] = useState(() => {
    if (typeof window === 'undefined') return false
    try {
      if (new URLSearchParams(window.location.search).get('renderer') === '2d') {
        window.localStorage.setItem('proxispeak:renderer', '2d')
        return true
      }
      return window.localStorage.getItem('proxispeak:renderer') === '2d'
    } catch {
      return false
    }
  })
  const use3D = webglAvailable && !sceneFailed && !force2D
  const [micOn, setMicOn] = useState(false)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(75)
  const [toast, setToast] = useState('')
  const [dragging, setDragging] = useState(false)
  const [socketConnected, setSocketConnected] = useState(false)
  const [socketError, setSocketError] = useState(null)
  const [roomId, setRoomId] = useState('')
  const [isInRoom, setIsInRoom] = useState(false)
  const [webrtcReady, setWebrtcReady] = useState(false)
  const [pendingCalls, setPendingCalls] = useState([])
  // A Socket.io connection is only opened after the backend has issued a signed
  // session for this office. `authError` carries the machine-readable rejection
  // code (never a token) so the UI can explain why the office is offline.
  const [authReady, setAuthReady] = useState(false)
  const [authError, setAuthError] = useState(null)
  const floorRef = useRef(null)
  const streamRef = useRef(null)
  const contextRef = useRef(null)
  const analyserRef = useRef(null)
  const frameRef = useRef(null)
  const keysRef = useRef({})
  const floorSizeRef = useRef({ width: 0, height: 0 }) // Latest measured floor size in pixels
  // Border widths of the floor panel. Percentages inside the floor resolve
  // against its padding box, so every pixel conversion has to start there too.
  const floorInsetsRef = useRef({ left: 0, right: 0, top: 0, bottom: 0 })
  const resizeObserverRef = useRef(null)
  const socketRef = useRef(null)
  const remoteUsersRef = useRef(new Map()) // socketId -> user data
  // Timestamp of the last position broadcast. Sends are throttled client-side so
  // the server's 20/s rate limit is never hit (a rejected update would surface as
  // a "RATE_LIMITED" toast).
  const lastPositionSentRef = useRef(0)

  // Measured floor size in CSS pixels. The collision model works in pixels so
  // the rendered 40px avatar keeps a constant physical footprint regardless of
  // the floor's size or aspect ratio.
  const [floorSize, setFloorSize] = useState({ width: 0, height: 0 })

  const me = people.find((p) => p.you)
  // Simulated colleagues exist so a solo visitor can try proximity without a
  // second human. They are labelled as demo everywhere, and they disappear as
  // soon as a real colleague is in the room: showing invented people next to
  // real participants would misstate who is present.
  const realRemoteCount = people.filter((person) => !person.you && !person.simulated).length
  const showSimulated = !isInRoom || realRemoteCount === 0
  const visiblePeople = showSimulated
    ? people
    : people.filter((person) => person.you || !person.simulated)
  const teammates = visiblePeople.filter((p) => !p.you)
  const online = teammates.filter((p) => p.online)

  // Socket.io connection and room management. The room comes from the signed-in
  // account's saved preference, not from a query parameter a client could forge
  // past the server's room allowlist.
  useEffect(() => {
    setRoomId(user?.preferences?.defaultRoom || 'design-team')

    return () => {
      disconnectSocket()
      remoteUsersRef.current.clear()
      destroyWebRTC()
    }
  }, [user?.preferences?.defaultRoom])

  // The authenticated account owns the display name shown on the floor and in
  // presence broadcasts. The server signs the same name into the room token, so
  // this local label and what other clients receive cannot disagree.
  useEffect(() => {
    if (!user?.name) return
    setPeople((prev) =>
      prev.map((person) =>
        person.you ? { ...person, name: user.name, role: 'You' } : person,
      ),
    )
  }, [user?.name])

  // Positions produced by the 3D controller (~10 Hz). The 2D floor and the
  // network layer consume the same state, so proximity behaves identically in
  // both renderers.
  const handleLocalSync = useCallback((position) => {
    setPeople((prev) =>
      prev.map((person) =>
        person.you
          ? person.x === position.x && person.y === position.y
            ? person
            : { ...person, x: position.x, y: position.y }
          : person,
      ),
    )
  }, [])

  // Acquire the server-issued session before any socket exists. The token binds
  // this browser session to the office room and is presented in the Socket.io
  // handshake; without it the server rejects the connection outright. The token is
  // kept in memory only (see src/utils/auth.js).
  useEffect(() => {
    if (!roomId) return undefined
    let cancelled = false
    setAuthReady(false)
    setAuthError(null)

    ;(async () => {
      try {
        const session = await requestSession({ roomId, name: 'You' })
        if (cancelled) return

        // STUN/TURN list for authenticated sessions. A failure here is not fatal:
        // the built-in STUN defaults still work, just without a relay fallback.
        try {
          const ice = await fetchIceServers({ token: session.token })
          if (!cancelled && ice) {
            configureWebRTC({
              iceServers: ice.iceServers,
              iceTransportPolicy: ice.iceTransportPolicy,
            })
          }
        } catch {
          // Keep the configured defaults.
        }

        if (cancelled) return
        setAuthReady(true)
      } catch (error) {
        if (cancelled) return
        setAuthReady(false)
        setAuthError(error?.code || 'AUTH_UNAVAILABLE')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [roomId])

  // Connect the socket when roomId is set, the session is issued, and the socket
  // is not already connected. The socket module is a singleton; connectSocket()
  // disconnects any existing socket before creating a new one, so calling it when
  // already connected is safe but unnecessary. We skip the call when the
  // module-level socket is already connected to avoid churn, and we never create a
  // circular dependency on `socketConnected` state (which is only set by the
  // onConnect callback below).
  useEffect(() => {
    if (!roomId || !authReady) return
    if (isSocketConnected()) return

    const socket = connectSocket(
      // onConnect
      () => {
        setSocketConnected(true)
        setSocketError(null)
        setAuthError(null)
        // Join the room after connecting
        joinRoom(roomId, 'You')
      },
      // onDisconnect
      (reason) => {
        setSocketConnected(false)
        setIsInRoom(false)
        // The server closes peer connections when this socket disconnects, so
        // keep none of them around locally either. Without this, a reconnect
        // could hold RTCPeerConnections (and audio graph nodes) whose remote
        // side no longer exists. The shared AudioContext is deliberately kept
        // (see cleanupAllPeers): closing it would leave the session unable to
        // resume audio after the reconnect.
        cleanupAllPeers()
        // Remote participants are identified by their old socket ids, which the
        // server will never reassign. Keeping them after a disconnect leaves
        // ghost avatars in the roster and stale ids in remoteUsersRef, so the
        // reconnect would try to negotiate with sockets that no longer exist.
        // Simulated demo colleagues (and the local avatar) are preserved.
        remoteUsersRef.current.clear()
        setPeople(prev => prev.filter(p => p.you || p.simulated))
        if (reason !== 'io server disconnect') {
          setToast('Disconnected from server: ' + reason)
        }
      },
      // onError
      (error) => {
        setSocketError(error)
        setToast('Socket error: ' + (error?.code || 'unknown'))
      }
    )

    socketRef.current = socket

    // Listen for room join confirmation
    const unsubscribeJoined = socketOn('office:joined', (data) => {
      setIsInRoom(true)
      setToast('Connected to ' + data.roomId)
    })

    // Listen for existing users in room (sent when joining)
    const unsubscribeUserList = socketOn('presence:list', (data) => {
      const { users } = data
      // Only touch state when there are users to add. An empty presence list
      // (single-user office) must not trigger a re-render, because the animation
      // loop reads people from the render closure and an extra setState here would
      // interleave with the frame callback and visibly slow movement.
      if (users.length === 0) return
      setPeople(prev => {
        let updated = [...prev]
        for (const user of users) {
          if (user.id === socket?.id) continue
          const existing = updated.find(p => p.id === user.id)
          if (!existing) {
            updated.push({
              ...user,
              you: false,
              simulated: false,
              online: true,
              speaking: false,
              x: 50,
              y: 50,
            })
          }
          remoteUsersRef.current.set(user.id, user)
        }
        return updated
      })
    })

    // Listen for other users joining
    const unsubscribeUserJoined = socketOn('presence:joined', (user) => {
      // Don't add ourselves
      if (user.id === socket?.id) return
      // Add or update remote user
      setPeople(prev => {
        // Check if user already exists (by socket id)
        const existing = prev.find(p => p.id === user.id)
        if (existing) {
          return prev.map(p => p.id === user.id ? { ...p, ...user, you: false, simulated: false } : p)
        }
        // Add new remote user
        return [...prev, {
          ...user,
          you: false,
          simulated: false,
          online: true,
          speaking: false,
          x: 50, // Start in center until they move
          y: 50,
        }]
      })
      remoteUsersRef.current.set(user.id, user)
    })

    // Listen for users leaving
    const unsubscribeUserLeft = socketOn('presence:left', (data) => {
      setPeople(prev => prev.filter(p => p.id !== data.userId))
      remoteUsersRef.current.delete(data.userId)
      setToast('A colleague left the office')
    })

    // Listen for position updates from other users
    const unsubscribePosition = socketOn('position:update', (data) => {
      // Don't update our own position (we handle that locally)
      if (data.userId === socket?.id) return
      setPeople(prev => prev.map(p => {
        if (p.id === data.userId) {
          return { ...p, x: data.x, y: data.y, updatedAt: data.updatedAt }
        }
        return p
      }))
    })

    // Listen for speaking updates
    const unsubscribeSpeaking = socketOn('speaking:update', (data) => {
      if (data.userId === socket?.id) return
      setPeople(prev => prev.map(p => {
        if (p.id === data.userId) {
          return { ...p, speaking: data.speaking }
        }
        return p
      }))
    })

    return () => {
      unsubscribeJoined()
      unsubscribeUserList()
      unsubscribeUserJoined()
      unsubscribeUserLeft()
      unsubscribePosition()
      unsubscribeSpeaking()
    }
  }, [roomId, authReady])

  // WebRTC initialization — runs once the socket is connected.
  // In jsdom there is no socket and no native WebRTC, so this effect gracefully
  // becomes a no-op instead of emitting console.error during the render commit
  // phase (which React reports as an un-wrapped state update / act warning and
  // can destabilize slow test workers).
  useEffect(() => {
    if (!socketConnected) return

    // Configure WebRTC with proximity settings
    configureWebRTC({
      proxispeak: {
        earshotPx: EARSHOT_RADIUS_PX,
        minVolume: 0.1,
        maxVolume: 1.0,
      },
    })

    // Initialize WebRTC with socket
    initWebRTC()
    setWebrtcReady(true)

    // Read-only diagnostics hook. It exposes connection state, remote track
    // kinds and gain values (never media, SDP, or credentials) so the browser
    // integration tests — and an operator with DevTools — can observe the real
    // peer state instead of inferring it from UI text.
    if (typeof window !== 'undefined') {
      window.__proxispeakWebrtc = { getPeerDiagnostics, getPeerStats }
      // Narrow, credential-free test/operator hook: sever the transport so the
      // reconnect path can be exercised deterministically. It exposes no token,
      // no SDP and no media.
      window.__proxispeakSession = {
        interruptConnection: () => {
          try {
            getSocket()?.io?.engine?.close()
          } catch {
            // Already closed.
          }
        },
      }
    }

    // Handle incoming call invites
    const handleIncomingCall = (event) => {
      setPendingCalls(prev => [...prev, event.detail])
    }

    window.addEventListener('webrtc:invite', handleIncomingCall)

    return () => {
      window.removeEventListener('webrtc:invite', handleIncomingCall)
      if (typeof window !== 'undefined' && window.__proxispeakWebrtc?.getPeerDiagnostics === getPeerDiagnostics) {
        delete window.__proxispeakWebrtc
      }
      if (typeof window !== 'undefined') {
        delete window.__proxispeakSession
      }
    }
  }, [socketConnected])

  // Handle new users joining - start peer connection.
  //
  // This runs whenever the roster changes, not only on the first join. After a
  // socket reconnect the client re-joins the room and receives a fresh
  // presence:list; without the roster dependency the local mic would never be
  // connected to peers that were re-announced after the interruption.
  useEffect(() => {
    if (!isInRoom || !webrtcReady) return

    const socket = getSocket()
    if (!socket) return

    // Only create connections that do not exist yet. Re-running this on every
    // roster change (10 position updates per second) must not renegotiate healthy
    // peers; mic enable/disable and renegotiation are handled in the WebRTC
    // service, which owns the connection lifecycle.
    const existing = new Set(getConnectedPeers())
    const remoteUsers = Array.from(remoteUsersRef.current.values())
    for (const user of remoteUsers) {
      if (user.id !== socket.id && !existing.has(user.id) && isMicActiveWebRTC()) {
        initiatePeerConnection(user.id, user.id, user.name)
      }
    }
  }, [isInRoom, webrtcReady, people])

  // Drive each remote peer's audio gain from the REAL pixel distance between the
  // two avatars. This is the audio counterpart of the earshot ring: the same
  // pctToPixels/pixelDistance math and the same EARSHOT_RADIUS_PX, applied to the
  // gain node that the remote track is played through. It runs whenever an avatar
  // moves or the floor is re-measured. Without it the gain node would stay at its
  // initial 0 and remote participants would be permanently inaudible.
  useEffect(() => {
    if (!me) return
    // Read the same dimensions the rest of the UI uses. `floorSize` is 0 in 3D
    // mode because the DOM floor is not mounted, so the fixed projection is the
    // correct physical floor there.
    const dims = use3D ? DEFAULT_FLOOR : floorSize
    if (dims.width <= 0 || dims.height <= 0) return

    const localPx = pctToPixels(me.x, me.y, dims.width, dims.height)

    for (const person of people) {
      if (person.you || !person.online || !person.id) continue
      // Only peers we actually hold a connection to can be attenuated.
      if (!remoteUsersRef.current.has(person.id)) continue
      const remotePx = pctToPixels(person.x, person.y, dims.width, dims.height)
      updateProximityVolume(person.id, localPx.x, localPx.y, remotePx.x, remotePx.y)
    }
  }, [people, floorSize, use3D])

  // If the account session is rejected (expired, revoked, or never present),
  // there is nothing the office can do with a room-scoped error banner: send the
  // visitor back through the login guard with the error already expired.
  useEffect(() => {
    if (!authError) return
    if (!['AUTH_REQUIRED', 'AUTH_REVOKED', 'AUTH_EXPIRED'].includes(authError)) return
    onSignedOut?.()
  }, [authError, onSignedOut])

  // Broadcast the local avatar position to the room.
  //
  // This is the single place that sends `position:update`, driven by the local
  // avatar's state instead of by the animation loop. Two earlier call sites read
  // `resolved` outside the scope where it was declared and captured `isInRoom`
  // from a stale closure, so nothing was ever sent in a real session (remote
  // avatars froze on the other clients). Sends are throttled to 10/s and a
  // trailing send guarantees the final resting position is always published.
  useEffect(() => {
    if (!isInRoom || !me) return
    if (!socketRef.current?.connected) return

    const POSITION_SEND_INTERVAL_MS = 100
    const send = () => {
      lastPositionSentRef.current = performance.now()
      socketUpdatePosition(me.x, me.y)
    }

    const elapsed = performance.now() - lastPositionSentRef.current
    if (elapsed >= POSITION_SEND_INTERVAL_MS) {
      send()
      return undefined
    }

    const timer = setTimeout(send, POSITION_SEND_INTERVAL_MS - elapsed)
    return () => clearTimeout(timer)
  }, [me?.x, me?.y, isInRoom]) // eslint-disable-line react-hooks/exhaustive-deps

  // Update floor dimensions and setup ResizeObserver
  useEffect(() => {
    const element = floorRef.current
    if (!element) return

    const updateDimensions = () => {
      // A queued ResizeObserver callback can still fire after the office has
      // been unmounted (route change / renderer switch), when React has already
      // nulled the ref. Measure the captured node and bail out if it is gone.
      if (!element || typeof element.getBoundingClientRect !== 'function') return
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const insets = {
        left: parseFloat(style.borderLeftWidth) || 0,
        right: parseFloat(style.borderRightWidth) || 0,
        top: parseFloat(style.borderTopWidth) || 0,
        bottom: parseFloat(style.borderBottomWidth) || 0,
      }
      floorInsetsRef.current = insets
      // The floor has a border, and children with `left: 30%` are placed
      // against the PADDING box. Measuring the padding box here keeps the
      // collision geometry identical to the drawn geometry.
      const size = {
        width: Math.max(0, rect.width - insets.left - insets.right),
        height: Math.max(0, rect.height - insets.top - insets.bottom),
      }
      floorSizeRef.current = size
      // Re-measure whenever the floor resizes so collision stays pixel-accurate.
      setFloorSize(size)
    }

    updateDimensions()

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserverRef.current = new ResizeObserver(() => {
        updateDimensions()
      })
      resizeObserverRef.current.observe(element)
    }

    return () => {
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect()
        resizeObserverRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 2500)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const id = setInterval(() => {
      setPeople((old) =>
        old.map((p) => {
          if (p.you || !p.online) return p
          const jitter = Math.random() < 0.18 ? (Math.random() - 0.5) * 7 : 0
          // Simulated colleagues obey the same furniture rules as the avatar, so
          // none of them can drift on top of a desk or sofa.
          const next =
            jitter === 0
              ? { x: p.x, y: p.y }
              : findNearestFreePosition(p.x + jitter, p.y + jitter, collisionOptionsFor(floorSizeRef.current))
          return {
            ...p,
            x: next.x,
            y: next.y,
            speaking: Math.random() < 0.09 ? !p.speaking : p.speaking,
          }
        }),
      )
    }, 4200)
    return () => clearInterval(id)
  }, [])

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    contextRef.current?.close()
    if (frameRef.current) cancelAnimationFrame(frameRef.current)
    setMicMeterLevel(0)
  }, [])

  // Keyboard movement effect. Attached in both renderers: the 2D floor reads the
  // key ref in its rAF loop, the 3D scene reads it in useFrame.
  useEffect(() => {
    if (!use3D && !floorRef.current) return

    const handleKeyDown = (e) => {
      const tag = (e.target.tagName || '').toLowerCase()
      const isTypingTarget =
        tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable

      // Only stop the browser's default scrolling when the avatar is the thing
      // being driven. A focused control (e.g. arrow keys on the volume slider)
      // keeps its own keyboard behaviour.
      if (
        !isTypingTarget &&
        ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)
      ) {
        e.preventDefault()
      }

      if (isTypingTarget) return
      if (dragging) return

      keysRef.current[e.key.toLowerCase()] = true
    }

    const handleKeyUp = (e) => {
      keysRef.current[e.key.toLowerCase()] = false
    }

    // If the window loses focus while a key is held, the matching keyup never
    // arrives and the avatar would keep gliding forever.
    const clearKeys = () => {
      keysRef.current = {}
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', clearKeys)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', clearKeys)
    }
  }, [dragging, use3D])

  // Smooth movement animation loop. Runs whenever the floor is measured; it does
  // NOT depend on `isInRoom` so that a socket connecting / joining the room does
  // not restart the loop and interfere with movement timing. The room-state check
  // is inside the loop body (for the socket emit) and reads the latest value from
  // a ref so it never causes a re-creation of the loop.
  useEffect(() => {
    // In 3D mode the scene owns the movement loop (delta-time inside useFrame).
    if (use3D) return
    if (!floorRef.current || floorSize.width <= 0 || floorSize.height <= 0) return

    const collisionOptions = {
      floorWidth: floorSize.width,
      floorHeight: floorSize.height,
      radiusPx: AVATAR_RADIUS_PX,
    }

    // A physical speed, so a diagonal and a straight line travel the same
    // number of pixels per second and the speed does not change with frame rate.
    const MOVE_SPEED_PX_PER_SEC = 90
    const ANIMATION_FRAME_RATE = 60
    const FRAME_DURATION = 1000 / ANIMATION_FRAME_RATE
    // Guard against huge jumps after a background tab resumes.
    const MAX_STEP_PX = 6

    let animationId
    let lastFrameTime = 0

    const animate = (timestamp) => {
      if (!lastFrameTime) lastFrameTime = timestamp
      const delta = timestamp - lastFrameTime

      // Only update at target frame rate. Distance is proportional to the time
      // that actually passed, so the avatar covers the same pixels per second on
      // a 30fps monitor, a 144Hz monitor or a slow frame - and a resumed
      // background tab cannot jump across the floor.
      if (delta >= FRAME_DURATION) {
        // The whole delta is consumed by this update, because the distance below
        // is proportional to it. Carrying a remainder here would make the avatar
        // cover more ground than the elapsed time allows.
        lastFrameTime = timestamp
        const stepPx = Math.min(MAX_STEP_PX, (MOVE_SPEED_PX_PER_SEC * delta) / 1000)

        const keys = keysRef.current

        let dx = 0
        let dy = 0

        // Calculate movement direction from keys
        if (keys['arrowup'] || keys['w']) dy -= 1
        if (keys['arrowdown'] || keys['s']) dy += 1
        if (keys['arrowleft'] || keys['a']) dx -= 1
        if (keys['arrowright'] || keys['d']) dx += 1

        if (dx !== 0 || dy !== 0) {
          // Normalize the direction so a diagonal moves at the same speed as a
          // straight line instead of ~41% faster.
          const magnitude = Math.hypot(dx, dy)
          const moveX = ((dx / magnitude) * stepPx * 100) / collisionOptions.floorWidth
          const moveY = ((dy / magnitude) * stepPx * 100) / collisionOptions.floorHeight

          // The live position is read from inside the state updater. This effect
          // is only re-created when the floor is re-measured, so reading
          // `people` from the render closure here would pin the avatar to the
          // position it had when the loop was created.
          setPeople((old) => {
            const current = old.find((p) => p.you)
            if (!current) return old

            const target = clampToFloorBoundaries(
              current.x + moveX,
              current.y + moveY,
              collisionOptions,
            )

            const resolved = resolveCollision(
              current.x,
              current.y,
              target.x,
              target.y,
              collisionOptions,
            )

            if (resolved.x === current.x && resolved.y === current.y) return old

            return old.map((p) =>
              p.you ? { ...p, x: resolved.x, y: resolved.y } : p,
            )
          })

          // The broadcast itself is handled by the position-sync effect below.
          // It used to happen here, which was wrong twice over: `resolved` is
          // scoped to the setPeople updater above, and `isInRoom` is captured
          // when this effect is created (before the room join resolves), so the
          // update never went out at all.
        }
      }

      animationId = requestAnimationFrame(animate)
    }

    animationId = requestAnimationFrame(animate)

    return () => {
      if (animationId) {
        cancelAnimationFrame(animationId)
      }
    }
  }, [floorSize, use3D]) // eslint-disable-line react-hooks/exhaustive-deps

  function moveAvatar(e) {
    if (!dragging || !floorRef.current) return
    // Support both pointer and touch events - both have clientX/clientY
    const clientX = e.clientX ?? e.touches?.[0]?.clientX ?? 0
    const clientY = e.clientY ?? e.touches?.[0]?.clientY ?? 0
    const rect = floorRef.current.getBoundingClientRect()
    const insets = floorInsetsRef.current
    const width = rect.width - insets.left - insets.right
    const height = rect.height - insets.top - insets.bottom
    if (width <= 0 || height <= 0) return

    const options = collisionOptionsFor({ width, height })
    const target = clampToFloorBoundaries(
      ((clientX - rect.left - insets.left) / width) * 100,
      ((clientY - rect.top - insets.top) / height) * 100,
      options,
    )

    setPeople((old) =>
      old.map((p) => {
        if (!p.you) return p
        // A drag obeys exactly the same collision rules as the keyboard: the
        // avatar slides along furniture instead of being dropped inside it.
        const resolved = resolveCollision(p.x, p.y, target.x, target.y, options)
        if (resolved.x === p.x && resolved.y === p.y) return p
        return { ...p, x: resolved.x, y: resolved.y }
      }),
    )

    // The broadcast itself is handled by the position-sync effect below.
  }

  function saveLayout() {
    const result = persistLayout(people)
    setToast(
      result.saved
        ? 'Layout saved in this browser.'
        : 'Could not save the layout in this browser.',
    )
  }

  function restoreLayout() {
    const result = readSavedLayout()
    if (!result.ok) {
      setToast(layoutErrorMessage(result.reason))
      return
    }
    setPeople((old) =>
      applySavedLayout(old, result.positions, collisionOptionsFor(floorSizeRef.current)),
    )
    setToast('Saved layout restored.')
  }

  function resetLayout() {
    // Reset the local avatar and the demo roster without evicting colleagues who
    // are actually connected. Replacing the whole roster here used to delete
    // every remote participant locally until the next presence event.
    setPeople((old) => {
      const previousLocal = old.find((person) => person.you)
      const defaults = createInitialPeople()
      const resetLocal = defaults.find((person) => person.you)
      const simulated = defaults.filter((person) => !person.you)
      const realRemotes = old.filter((person) => !person.you && !person.simulated)

      return [
        {
          ...resetLocal,
          name: previousLocal?.name ?? resetLocal.name,
          role: previousLocal?.role ?? resetLocal.role,
          emoji: previousLocal?.emoji ?? resetLocal.emoji,
        },
        ...simulated,
        ...realRemotes,
      ]
    })
    setToast('Avatar positions reset.')
  }

  async function toggleMic() {
    if (streamRef.current) {
      // Turn off mic
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      contextRef.current?.close()
      contextRef.current = null
      analyserRef.current = null
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      setMicMeterLevel(0)
      setMicOn(false)
      setMuted(false)
      setToast('Microphone disabled.')
      
      // Release WebRTC mic
      releaseMicWebRTC()
      
      // Notify server that we're no longer speaking
      if (socketRef.current?.connected && isInRoom) {
        socketUpdateSpeaking(false)
      }
      return
    }
    try {
      // Request mic through WebRTC service (which handles both local and remote)
      const stream = await requestMicWebRTC()
      streamRef.current = stream
      
      // Also set up local audio visualization
      const Ctx = window.AudioContext || window.webkitAudioContext
      const ctx = new Ctx()
      if (ctx.state === 'suspended') await ctx.resume()
      contextRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      analyserRef.current = analyser
      const data = new Uint8Array(analyser.frequencyBinCount)
      let meterFrame = 0
      const draw = () => {
        if (!analyserRef.current) return
        analyser.getByteFrequencyData(data)
        const avg = data.reduce((a, b) => a + b, 0) / data.length
        const mutedNow = Boolean(
          streamRef.current?.getAudioTracks().some((t) => !t.enabled),
        )
        const level = mutedNow ? 0 : Math.min(100, avg * 1.7)
        const meter = document.getElementById('micmeter')
        if (meter) {
          meter.style.setProperty('--level', `${level}%`)
          if (meterFrame % 15 === 0) {
            meter.setAttribute('aria-valuenow', String(Math.round(level)))
          }
        }
        meterFrame += 1
        frameRef.current = requestAnimationFrame(draw)
      }
      draw()
      setMicOn(true)
      setMuted(false)
      setToast('Microphone enabled. Connecting to peers...')
      
      // Start peer connections with existing users
      if (socketRef.current?.connected && isInRoom && webrtcReady) {
        const remoteUsers = Array.from(remoteUsersRef.current.values())
        for (const user of remoteUsers) {
          if (user.id !== socketRef.current.id) {
            initiatePeerConnection(user.id, user.id, user.name)
          }
        }
      }
      
      // Notify server that we're speaking (mic is on)
      if (socketRef.current?.connected && isInRoom) {
        socketUpdateSpeaking(true)
      }
    } catch {
      setToast('Microphone access failed. Use localhost/HTTPS and allow permission.')
    }
  }

  function toggleMute() {
    if (!streamRef.current) return
    const next = !muted
    streamRef.current.getAudioTracks().forEach((t) => (t.enabled = !next))
    setMuted(next)
    // Notify server of speaking state change
    if (socketRef.current?.connected && isInRoom) {
      socketUpdateSpeaking(!next) // speaking when not muted
    }
  }

  const nav = [
    { icon: LayoutGrid, label: 'Virtual Office' },
    { icon: Users, label: 'Colleagues' },
    { icon: AudioLines, label: 'Audio & Mic' },
    { icon: Save, label: 'Saved Layouts' },
    { icon: Settings, label: 'Settings' },
  ]
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false)

  // Pixel distances for each online colleague. The 3D scene projects the office
  // onto the same 900×540 floor the collision model uses, so the fixed size is
  // the physically correct one when the DOM floor is not mounted.
  const floorDims = use3D ? DEFAULT_FLOOR : floorSize
  const hasFloorDimensions = floorDims.width > 0 && floorDims.height > 0

  const colleagueDistances = online.map((p) => ({
    person: p,
    distancePx: hasFloorDimensions
      ? pixelDistance(me, p, floorDims.width, floorDims.height)
      : null,
  }))

  // Nearby colleagues (within 100px earshot)
  const nearby = colleagueDistances
    .filter((cd) => cd.distancePx !== null && isWithinEarshot(cd.distancePx))
    .map((cd) => cd.person)

  // Nearest colleague and distance
  const nearestEntry = colleagueDistances
    .filter((cd) => cd.distancePx !== null)
    .sort((a, b) => a.distancePx - b.distancePx)[0]
  const nearest = nearestEntry ? nearestEntry.person : null
  const nearestDistancePx = nearestEntry ? nearestEntry.distancePx : null

  // Proximity gain for nearest colleague (for display)
  const gain =
    nearestDistancePx !== null ? proximityStrength(nearestDistancePx) : 0

  return (
    <div className="min-h-screen bg-[#071827] pb-16 text-slate-100 lg:pb-0">
      <header className="flex h-[72px] items-center justify-between border-b border-white/10 bg-[#091d2c] px-4 md:px-7">
        <div className="flex items-center gap-3">
          <button
            onClick={onHome}
            className="rounded-lg p-2 text-slate-300 hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-mint"
            aria-label="Back to landing page"
          >
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-mint text-xl font-black text-ink" aria-hidden="true">
            ♫
          </div>
          <div>
            <div className="font-extrabold">
              Proxi<span className="text-mint">Speak</span>
            </div>
            <div className="text-[11px] text-slate-400">Virtual Office</div>
          </div>
        </div>
        <div className="hidden items-center gap-3 text-xs text-slate-300 sm:flex">
          {user && (
            <span className="hidden max-w-[160px] truncate rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[11px] font-semibold text-slate-200 md:inline">
              {user.name}
            </span>
          )}
          {onSettings && (
            <button
              type="button"
              onClick={onSettings}
              className="rounded-lg p-2 text-slate-300 hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-mint"
              aria-label="Account settings"
            >
              <Settings size={17} aria-hidden="true" />
            </button>
          )}
          {user && (
            <button
              type="button"
              onClick={async () => {
                await logout()
                onSignedOut?.()
              }}
              className="rounded-lg p-2 text-slate-300 hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-mint"
              aria-label="Sign out"
            >
              <LogOut size={17} aria-hidden="true" />
            </button>
          )}
          {socketConnected && isInRoom ? (
            webrtcReady && isMicActiveWebRTC() ? (
              <span className="rounded-full border border-emerald-700/50 bg-emerald-900/30 px-3 py-2 text-emerald-200">
                ● CONNECTED · AUDIO LIVE
              </span>
            ) : webrtcReady ? (
              <span className="rounded-full border border-amber-700/50 bg-amber-900/30 px-3 py-2 text-amber-200">
                ● CONNECTED · MIC OFF
              </span>
            ) : (
              <span className="rounded-full border border-sky-700/50 bg-sky-900/30 px-3 py-2 text-sky-200">
                ● CONNECTED · WEBRTC PENDING
              </span>
            )
          ) : socketConnected ? (
            <span className="rounded-full border border-amber-700/50 bg-amber-900/30 px-3 py-2 text-amber-200">
              ● NOT IN ROOM
            </span>
          ) : (
            <span className="rounded-full border border-slate-700/50 bg-slate-900/30 px-3 py-2 text-slate-400">
              ● DISCONNECTED
            </span>
          )}
          <div className="grid h-9 w-9 place-items-center rounded-full bg-orange-200 font-bold text-slate-900" aria-hidden="true">
            A
          </div>
        </div>
        {/* Mobile menu toggle */}
        <button
          onClick={() => setMobilePanelOpen(!mobilePanelOpen)}
          className="rounded-lg p-2 text-slate-300 hover:bg-white/5 lg:hidden focus-visible:outline-2 focus-visible:outline-mint"
          aria-label={mobilePanelOpen ? 'Close colleague panel' : 'Open colleague panel'}
          aria-expanded={mobilePanelOpen}
        >
          <Users size={20} aria-hidden="true" />
        </button>
      </header>
      <div className="grid min-h-[calc(100vh-72px)] lg:grid-cols-[215px_minmax(0,1fr)]">
        {/* Desktop sidebar */}
        <aside className="hidden border-r border-white/10 bg-[#0a1f2e] p-4 lg:flex lg:flex-col">
          <div className="mb-3 px-3 pt-3 text-[10px] font-extrabold uppercase tracking-[.18em] text-slate-500">
            Workspace
          </div>
          {nav.map(({ icon: Icon, label }, i) => (
            <button
              key={label}
              onClick={() => {
                if (label === 'Saved Layouts') restoreLayout()
                else if (label === 'Settings') {
                  if (onSettings) onSettings()
                  else setToast('Account settings are available from the top bar.')
                }
                else
                  document
                    .getElementById(i === 1 ? 'colleagues' : i === 2 ? 'audio' : 'office')
                    ?.scrollIntoView({ behavior: 'smooth' })
              }}
              className={`mb-1 flex items-center gap-3 rounded-xl px-3 py-3 text-left text-sm focus-visible:outline-2 focus-visible:outline-mint ${
                i === 0 ? 'bg-teal-950 text-mint' : 'text-slate-300 hover:bg-white/5'
              }`}
              aria-current={i === 0 ? 'page' : undefined}
            >
              <Icon size={16} aria-hidden="true" />
              {label}
            </button>
          ))}
          <div className="mt-auto rounded-xl border border-white/10 bg-[#0d2938] p-4">
            <div className="text-xs font-bold">ProxiSpeak tip</div>
            <p className="my-2 text-xs leading-5 text-slate-400">
              Drag your avatar to update the distance estimate to teammates.
            </p>
          </div>
        </aside>

        {/* Mobile colleague panel */}
        {mobilePanelOpen && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <div className="absolute inset-0 bg-black/60" onClick={() => setMobilePanelOpen(false)} />
            <div className="relative bg-[#0a1f2e] h-full overflow-y-auto">
              <div className="sticky top-0 bg-[#0a1f2e] border-b border-white/10 px-4 py-3 flex items-center justify-between">
                <span className="text-xs font-extrabold uppercase tracking-[.18em] text-slate-500">
                  Workspace
                </span>
                <button
                  onClick={() => setMobilePanelOpen(false)}
                  className="rounded-lg p-2 text-slate-300 hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-mint"
                  aria-label="Close panel"
                >
                  <ArrowLeft size={20} aria-hidden="true" />
                </button>
              </div>
              <div className="p-4 space-y-2">
                {nav.map(({ icon: Icon, label }, i) => (
                  <button
                    key={label}
                    onClick={() => {
                      setMobilePanelOpen(false)
                      if (label === 'Saved Layouts') restoreLayout()
                      else if (label === 'Settings') {
                        if (onSettings) onSettings()
                        else setToast('Account settings are available from the top bar.')
                      }
                      else
                        document
                          .getElementById(i === 1 ? 'colleagues' : i === 2 ? 'audio' : 'office')
                          ?.scrollIntoView({ behavior: 'smooth' })
                    }}
                    className={`w-full flex items-center gap-3 rounded-xl px-3 py-3 text-left text-sm focus-visible:outline-2 focus-visible:outline-mint ${
                      i === 0 ? 'bg-teal-950 text-mint' : 'text-slate-300 hover:bg-white/5'
                    }`}
                  >
                    <Icon size={16} aria-hidden="true" />
                    {label}
                  </button>
                ))}
              </div>
              {/* Quick colleague summary for mobile */}
              <div className="p-4 border-t border-white/10">
                <h3 className="text-xs font-extrabold uppercase tracking-[.18em] text-slate-500 mb-3">
                  Quick Overview
                </h3>
                <div className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-xs text-slate-400">Teammates online</span>
                    <span className="text-sm font-bold text-mint">{online.length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-xs text-slate-400">Within earshot</span>
                    <span className="text-sm font-bold text-mint">{nearby.length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-xs text-slate-400">Connection</span>
                    <span className="text-sm font-bold" style={{ color: socketConnected && isInRoom ? '#45e0c0' : '#94a3b8' }}>
                      {socketConnected && isInRoom ? 'Live' : 'Offline'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-xs text-slate-400">Your mic</span>
                    <span
                      className="text-sm font-bold"
                      style={{ color: !micOn ? '#94a3b8' : muted ? '#fb7185' : '#45e0c0' }}
                    >
                      {!micOn ? 'Off' : muted ? 'Muted' : 'Live'}
                    </span>
                  </div>
                </div>
                <details className="mt-4 group">
                  <summary className="text-xs font-semibold text-slate-300 cursor-pointer hover:text-mint list-none flex items-center gap-2">
                    <Users size={14} aria-hidden="true" />
                    All colleagues ({teammates.length})
                    <span className="text-slate-500 group-open:rotate-180">▼</span>
                  </summary>
                  <div className="mt-2 space-y-2">
                    {teammates.map((p) => {
                      const distEntry = colleagueDistances.find((cd) => cd.person.id === p.id)
                      const distPx = distEntry ? distEntry.distancePx : null
                      return (
                        <div key={p.id} className="flex items-center gap-2 text-xs">
                          <div
                            style={{ background: p.color }}
                            className="w-6 h-6 rounded-lg flex items-center justify-center text-xs shrink-0"
                          >
                            {p.emoji}
                          </div>
                          <span className="flex-1 truncate">{p.name}</span>
                          <span className="text-slate-500">
                            {!p.online ? 'Offline' : p.speaking ? '♫' : p.role}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </details>
              </div>
            </div>
          </div>
        )}

        <main className="min-w-0 p-3 md:p-6">
          <div className="mb-5 flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <div>
              <div className="text-[11px] font-extrabold uppercase tracking-[.18em] text-mint">
                Your digital workspace
              </div>
              <h1 className="mt-1 text-2xl font-black tracking-tight md:text-3xl">Virtual Office</h1>
              <p className="mt-1 text-sm text-slate-400">
                Move around, find colleagues, and talk naturally as you get closer.
              </p>
              <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-slate-900/30 border border-slate-700/40 px-2 py-0.5 text-[10px] font-medium text-slate-400">
                <span aria-hidden="true">●</span>
                {socketConnected && isInRoom ? 'Real-time with ' + remoteUsersRef.current.size + ' remote' : 'Demo mode — colleagues are simulated'}
              </span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={resetLayout}
                className="rounded-xl border border-white/10 bg-[#10293a] px-3 py-2.5 text-xs font-semibold hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-mint"
                aria-label="Reset avatar positions to default"
              >
                <RotateCcw className="mr-1 inline" size={15} aria-hidden="true" />
                Reset positions
              </button>
              <button
                onClick={saveLayout}
                className="rounded-xl bg-mint px-3 py-2.5 text-xs font-extrabold text-ink hover:bg-teal-200 focus-visible:outline-2 focus-visible:outline-mint"
                aria-label="Save current avatar positions"
              >
                <Save className="mr-1 inline" size={15} aria-hidden="true" />
                Save layout
              </button>
            </div>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat
              title="Colleagues online"
              value={online.length}
              foot={socketConnected && isInRoom ? 'Real-time presence' : 'Simulated presence'}
              description={socketConnected && isInRoom ? 'Connected colleagues via Socket.io' : 'These are demo colleagues, not real connected users'}
              accent
              dataTestId="stat-colleagues"
            />
            <Stat
              title="Nearby colleagues"
              value={nearby.length}
              foot={`Within ${EARSHOT_RADIUS_PX}px earshot`}
              description="Pixel-based distance calculation"
              accent
              dataTestId="stat-nearby"
            />
            <Stat
              title="Your microphone"
              value={!micOn ? 'Off' : muted ? 'Muted' : 'Live'}
              foot={!micOn ? 'Mic is disabled' : muted ? 'Microphone muted' : 'Local input active'}
              description={
                !micOn
                  ? 'Click Enable mic to grant permission'
                  : muted
                    ? 'Click Unmute to resume'
                    : 'Local mic active — no remote audio yet'
              }
              dataTestId="stat-mic"
            />
            <Stat
              title="Proximity audio"
              value={gain > 65 ? 'Close' : gain > 15 ? 'Nearby' : 'Quiet'}
              foot="Visual estimate only"
              description="Audio gain follows the same earshot distance"
              accent
              dataTestId="stat-proximity"
            />
          </div>

          <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_290px]">
            <section id="office" className="min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-[#0b2030]">
              <div className="flex h-[58px] items-center justify-between border-b border-white/10 px-4">
                <div>
                  <h2 className="text-sm font-bold">Design Team Floor</h2>
                  <p className="mt-1 text-[11px] text-slate-400">
                    {use3D
                      ? '3D shared space · WASD to walk · click the floor · drag to orbit'
                      : '2D fallback · drag your avatar'}
                  </p>
                </div>
                <span className="text-xs text-slate-400">FLOOR 04</span>
              </div>
              <div className="bg-[#081a27] p-2 md:p-3">
                {use3D ? (
                  <div
                    className="relative h-[450px] overflow-hidden rounded-xl border border-slate-600/70 bg-[#07131c] sm:h-[540px]"
                    data-testid="office-scene-3d"
                  >
                    <SceneBoundary onError={() => setSceneFailed(true)}>
                      <Suspense
                        fallback={
                          <div className="grid h-full place-items-center text-xs text-slate-400" role="status">
                            Loading the 3D office…
                          </div>
                        }
                      >
                        <OfficeScene
                          people={visiblePeople}
                          me={me}
                          keysRef={keysRef}
                          onSync={handleLocalSync}
                          muted={muted}
                        />
                      </Suspense>
                    </SceneBoundary>
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-between gap-2 bg-gradient-to-t from-[#07131c] to-transparent px-3 pb-2 pt-6 text-[10px] text-slate-300">
                      <span>
                        <span className="font-bold text-mint">W A S D</span> / arrows to walk · click the floor to move
                      </span>
                      <span>drag to orbit · scroll to zoom</span>
                    </div>
                  </div>
                ) : (
                <div
                  ref={floorRef}
                  onPointerMove={dragging ? moveAvatar : undefined}
                  onPointerUp={() => setDragging(false)}
                  onPointerCancel={() => setDragging(false)}
                  onPointerLeave={() => dragging && setDragging(false)}
                  className="office-floor relative h-[450px] overflow-hidden rounded-xl border border-slate-600/70 sm:h-[540px]"
                >
                  {OFFICE_LAYOUT.rooms.map((room) => (
                    <Room
                      key={room.id}
                      id={room.id}
                      className={room.className}
                      label={room.label}
                      x={room.x}
                      y={room.y}
                      w={room.w}
                      h={room.h}
                    />
                  ))}
                  {/* Furniture is positioned from the shared layout's floor
                      percentages, not from inside the room box. CSS resolves a
                      child's percentage against the room's *padding* box (the
                      room has a 5px border), which used to shift the drawn
                      desks/sofas up to 5px away from the rectangles the
                      collision model blocks. Rendering them from the same
                      rectangles keeps the two identical. */}
                  {FURNITURE.map((item) => (
                    <Furniture key={item.id} item={item} />
                  ))}
                  <span className="plant p1" />
                  <span className="plant p2" />
                  <span className="plant p3" />
                  <span className="watercooler" />

                  <div className="absolute right-2 top-2 rounded-lg border border-slate-500/60 bg-slate-900/85 px-2 py-2 text-[9px] text-slate-200 sm:text-[10px] sm:hidden">
                    ↖ Drag your avatar
                  </div>
                  <div className="absolute left-2 bottom-2 rounded-lg border border-slate-500/60 bg-slate-900/85 px-2 py-2 text-[9px] text-slate-200 sm:text-[10px]">
                    <span className="font-bold text-mint" aria-hidden="true">
                      W A S D
                    </span>{' '}
                    / arrows to move
                  </div>

                  {/* Earshot circle for local avatar - stays centered using translate(-50%,-50%) in CSS */}
                  {me && hasFloorDimensions && (
                    <div
                      className="earshot-circle"
                      style={{
                        left: `${me.x}%`,
                        top: `${me.y}%`,
                        width: `${EARSHOT_RADIUS_PX * 2}px`,
                        height: `${EARSHOT_RADIUS_PX * 2}px`,
                      }}
                      aria-hidden="true"
                    />
                  )}

                  {visiblePeople.map((p) => (
                    <div
                      key={p.id}
                      onPointerDown={
                        p.you
                          ? (e) => {
                              // Set dragging state and pointer capture so move events
                              // retarget to this avatar element after capture
                              e.currentTarget.setPointerCapture(e.pointerId)
                              setDragging(true)
                            }
                          : (!p.simulated && socketConnected && isInRoom)
                            ? () => {}
                            : () =>
                              setToast('This colleague is simulated in this local prototype.')
                      }
                      onPointerMove={moveAvatar}
                      onPointerUp={() => setDragging(false)}
                      onPointerCancel={() => setDragging(false)}
                      onTouchStart={
                        p.you
                          ? (e) => {
                              // Prevent default to avoid scrolling while dragging
                              e.preventDefault()
                              // Use the first touch point
                              if (e.touches && e.touches.length > 0) {
                                setDragging(true)
                              }
                            }
                          : () =>
                              setToast('This colleague is simulated in this local prototype.')
                      }
                      onTouchMove={moveAvatar}
                      onTouchEnd={() => setDragging(false)}
                      onTouchCancel={() => setDragging(false)}
                      style={{ left: `${p.x}%`, top: `${p.y}%` }}
                      className={`absolute z-10 w-[72px] -translate-x-1/2 -translate-y-[20px] touch-none text-center ${
                        p.you ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
                      }`}
                      role="button"
                      aria-label={`${p.name}${
                        p.you ? ', you' : ''
                      }${p.online ? ', online' : ', offline'}${p.speaking ? ', speaking' : ''}${
                        p.simulated ? ', simulated colleague' : ''
                      }`}
                      aria-current={p.you ? 'true' : undefined}
                      aria-describedby={p.you ? 'local-avatar-desc' : undefined}
                    >
                      <div
                        style={{ background: p.color }}
                        className={`relative mx-auto grid h-10 w-10 place-items-center rounded-full border-[3px] border-white text-xl shadow-lg ${
                          p.speaking ? 'ring-4 ring-rose-400/30' : ''
                        } ${p.you ? 'avatar-local' : 'avatar-simulated'}`}
                      >
                        <span aria-hidden="true">{p.emoji}</span>
                        {/* Status indicator with text alternative */}
                        <span
                          className={`absolute bottom-[-2px] right-[-2px] h-3 w-3 rounded-full border-2 border-white ${
                            !p.online ? 'bg-slate-400' : p.speaking ? 'bg-rose-400' : 'bg-emerald-400'
                          }`}
                          aria-hidden={!p.speaking}
                          title={!p.online ? 'Offline' : p.speaking ? 'Speaking' : 'Online'}
                        />
                        {/* Speaking indicator icon */}
                        {p.speaking && (
                          <span className="absolute -top-1 -right-1 text-[8px] text-rose-400" aria-hidden="true">
                            ♫
                          </span>
                        )}
                      </div>
                      <span className="mt-1 inline-block max-w-full truncate rounded-md bg-white px-1.5 py-0.5 text-[9px] font-extrabold text-slate-800">
                        {p.name}
                        {p.simulated && !p.you && (
                          <span className="ml-1 text-[8px] text-slate-500">(demo)</span>
                        )}
                      </span>
                      <div className="mt-0.5 text-[8px] font-bold text-slate-600">
                        {p.you
                          ? 'YOU (local)'
                          : p.speaking
                            ? 'SPEAKING'
                            : p.online
                              ? 'ONLINE'
                              : 'OFFLINE'}
                        {p.simulated && !p.you && (
                          <span className="ml-1 text-slate-500">· demo</span>
                        )}
                      </div>
                    </div>
                  ))}
                  <div className="absolute bottom-2 left-2 rounded-lg bg-white/90 px-2 py-1.5 text-[9px] font-extrabold tracking-wider text-emerald-900">
                    FLOOR 04 · DESIGN & PRODUCT
                  </div>
                </div>
                )}
                {webglAvailable && sceneFailed && (
                  <p
                    role="status"
                    className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-5 text-amber-200"
                  >
                    3D rendering is unavailable in this browser, so the accessible 2D floor is shown
                    instead. Presence and proximity audio continue to work.
                  </p>
                )}
              </div>
            </section>

            {/* Hidden description for local avatar */}
            <div id="local-avatar-desc" className="sr-only">
              You are controlling this avatar. Use WASD or arrow keys to move, or drag with your mouse. Your position is shown as a percentage on the office floor.
            </div>

            <aside className="overflow-hidden rounded-2xl border border-white/10 bg-[#0b2030]">
              <div className="flex h-[58px] items-center justify-between border-b border-white/10 px-4">
                <div>
                  <h2 className="text-sm font-bold">People in your office</h2>
                  <p className="mt-1 text-[11px] text-slate-400">{online.length} teammates · demo presence</p>
                </div>
                <span className="rounded-full border border-slate-700/50 bg-slate-900/30 px-2 py-1 text-[10px] text-slate-400">
                  ● {socketConnected && isInRoom ? 'Live' : 'Demo'}
                </span>
              </div>
              <div id="colleagues" data-testid="colleagues-panel" className="p-3">
                {teammates.map((p) => {
                  const distEntry = colleagueDistances.find((cd) => cd.person.id === p.id)
                  const distPx = distEntry ? distEntry.distancePx : null
                  const isNearby = distPx !== null && isWithinEarshot(distPx)
                  const strength = distPx !== null ? proximityStrength(distPx) : 0
                  const isRemote = !p.simulated && p.id !== 'you'

                  return (
                    <div
                      key={p.id}
                      className={`flex items-center gap-2.5 border-b border-white/5 py-3 last:border-0 ${
                        isNearby ? 'bg-teal-950/30 rounded-lg p-2 -mx-2' : 'hover:bg-white/5'
                      }`}
                      aria-label={`${p.name}, ${p.role}${
                        p.online ? ', online' : ', offline'
                      }${p.speaking ? ', speaking' : ''}${
                        isNearby
                          ? `, ${Math.round(distPx)} pixels away, within earshot`
                          : distPx !== null
                            ? `, ${Math.round(distPx)} pixels away`
                            : ', distance unknown'
                      }${isRemote ? ', remote user' : ''}
                      }`}
                    >
                      <div
                        style={{ background: p.color }}
                        className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-lg"
                        aria-hidden="true"
                      >
                        {p.emoji}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[11px] font-bold flex items-center gap-1">
                          {p.name}
                          {p.simulated && !p.you && (
                            <span className="text-[9px] text-slate-500 font-normal bg-slate-800 px-1 rounded" title="This is a simulated colleague for demo purposes">
                              demo
                            </span>
                          )}
                          {isRemote && (
                            <span className="text-[9px] text-teal-400 font-normal bg-teal-950/50 px-1 rounded" title="This is a real connected user">
                              live
                            </span>
                          )}
                          {p.speaking && (
                            <span className="text-rose-300 text-[10px]" aria-label="speaking">
                              ♫ speaking
                            </span>
                          )}
                        </div>
                        <div className="mt-1 truncate text-[10px] text-slate-400">
                          {!p.online
                            ? 'Offline'
                            : p.speaking
                              ? 'Speaking now'
                              : isRemote ? 'Connected' : p.role}
                        </div>
                        {p.online && distPx !== null && (
                          <div className="mt-1 flex items-center gap-2">
                            <span className="text-[9px] text-slate-400">{Math.round(distPx)}px</span>
                            {isNearby && (
                              <div
                                className="proximity-bar flex-1 max-w-[80px]"
                                aria-label={`Proximity strength: ${Math.round(strength)}%`}
                              >
                                <div className="proximity-bar-fill" style={{ width: `${strength}%` }} />
                              </div>
                            )}
                            {isNearby && <span className="text-[9px] text-emerald-400">earshot</span>}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
              <div id="audio" className="border-t border-white/10 p-4">
                <h3 className="mb-3 text-xs font-extrabold">Microphone & audio settings</h3>
                <div className="rounded-xl border border-emerald-800/70 bg-emerald-950/50 p-3">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <Mic size={14} aria-hidden="true" />
                      <span className="font-bold">Your microphone</span>
                    </div>
                    <span
                      className={`font-bold ${
                        !micOn ? 'text-slate-400' : muted ? 'text-rose-300' : 'text-emerald-300'
                      }`}
                      aria-label={!micOn ? 'Microphone is off' : muted ? 'Microphone is muted' : 'Microphone is live'}
                    >
                      {!micOn ? 'OFF' : muted ? 'MUTED' : 'LIVE'}
                    </span>
                  </div>

                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={toggleMic}
                      className={`flex-1 rounded-lg px-2 py-2.5 text-[11px] font-extrabold focus-visible:outline-2 focus-visible:outline-mint ${
                        micOn ? 'bg-rose-950 text-rose-200 hover:bg-rose-800' : 'bg-mint text-ink hover:bg-teal-100'
                      }`}
                      aria-pressed={micOn}
                      aria-label={micOn ? 'Disable microphone' : 'Enable microphone'}
                    >
                      {micOn ? 'Disable mic' : 'Enable mic'}
                    </button>
                    <button
                      disabled={!micOn}
                      onClick={toggleMute}
                      className="flex-1 rounded-lg bg-[#173e4c] px-2 py-2.5 text-[11px] font-extrabold text-slate-100 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#1a4a5a] focus-visible:outline-2 focus-visible:outline-mint"
                      aria-pressed={muted}
                      aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
                    >
                      {muted ? 'Unmute' : 'Mute'}
                    </button>
                  </div>

                  <div
                    id="micmeter"
                    data-testid="mic-meter"
                    className="mic-meter mt-3 h-1.5 overflow-hidden rounded-full bg-slate-700"
                    role="meter"
                    aria-label="Microphone input level"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    aria-valuenow={0}
                  >
                    <span style={{ '--level': '0%' }} />
                  </div>

                  <div className="mt-4 flex items-center gap-2">
                    <label htmlFor="output-volume" className="whitespace-nowrap text-[10px] text-slate-400">
                      Output volume (visual only)
                    </label>
                    <input
                      id="output-volume"
                      type="range"
                      min="0"
                      max="100"
                      value={volume}
                      onChange={(e) => setVolume(Number(e.target.value))}
                      className="volume-slider flex-1"
                      aria-label="Output volume slider — visual only, no remote audio connected"
                      aria-describedby="volume-note"
                    />
                    <span className="w-8 text-right text-[10px] text-mint font-medium">{volume}%</span>
                  </div>
                  <p id="volume-note" className="mt-1 text-[9px] leading-3 text-slate-500">
                    This slider is visual-only and does not change remote audio. Remote
                    audio is attenuated automatically by proximity.
                  </p>

                  <div className="mt-3 flex justify-between text-[10px] text-slate-400">
                    <span>Nearest colleague</span>
                    <strong className="text-slate-100">
                      {nearest
                        ? `${nearest.name.split(' ')[0]} · ${Math.round(nearestDistancePx)}px away`
                        : 'No one online'}
                    </strong>
                  </div>

                  <div className="mt-2 flex justify-between text-[10px] text-slate-400">
                    <span>Proximity strength</span>
                    <strong className="text-mint">{Math.round(gain)}%</strong>
                  </div>

                  <p className="mt-3 text-[10px] leading-4 text-slate-400">
                    {socketConnected && isInRoom
                      ? 'Position synced via Socket.io. Remote audio attenuates automatically once both participants enable their microphone.'
                      : 'Not connected to a server. No remote voice streams, so no audio attenuation is applied.'}
                  </p>
                </div>
              </div>
              <div className="m-3 rounded-xl border border-slate-700/40 bg-slate-950/30 p-3 text-[10px] leading-5 text-slate-300">
                <strong>Status</strong>
                <br />
                {socketConnected && isInRoom
                  ? webrtcReady && isMicActiveWebRTC()
                    ? 'WebRTC audio active. Real-time position sync & peer audio connected.'
                    : 'Socket.io connected. Position sync active. Enable mic for WebRTC audio.'
                  : 'This demo simulates colleagues locally. Connect to a server for real multi-user presence.'}
                {authError && (
                  <p className="mt-1 text-rose-300">
                    Secure session unavailable ({authError}). Check the server, CLIENT_ORIGIN and
                    SESSION_SECRET configuration.
                  </p>
                )}
              </div>
            </aside>
          </div>
        </main>
      </div>

      {/* Mobile controls bar */}
      <div className="mobile-controls-panel lg:hidden" role="region" aria-label="Mobile controls">
        <div className="flex items-center gap-3 flex-1">
          <button
            onClick={resetLayout}
            className="flex items-center gap-1.5 rounded-lg bg-[#10293a] px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-mint"
            aria-label="Reset avatar positions"
          >
            <RotateCcw size={12} aria-hidden="true" />
            Reset
          </button>
          <button
            onClick={saveLayout}
            className="flex items-center gap-1.5 rounded-lg bg-mint px-2.5 py-1.5 text-xs font-bold text-ink hover:bg-teal-200 focus-visible:outline-2 focus-visible:outline-mint"
            aria-label="Save layout"
          >
            <Save size={12} aria-hidden="true" />
            Save
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-500">Mic:</span>
          <button
            onClick={toggleMic}
            className={`flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold ${
              micOn ? 'bg-rose-950 text-rose-200' : 'bg-mint text-ink'
            } hover:opacity-90 focus-visible:outline-2 focus-visible:outline-mint`}
            aria-label={micOn ? 'Disable microphone' : 'Enable microphone'}
            aria-pressed={micOn}
          >
            <Mic size={10} aria-hidden="true" />
            {micOn ? (muted ? 'Muted' : 'Live') : 'Off'}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-500">Nearby:</span>
          <span className="text-xs font-bold text-mint">{nearby.length}</span>
        </div>
      </div>

      {/* Toast notification */}
      {toast && (
        <div
          role="status"
          className="fixed bottom-16 left-1/2 z-50 -translate-x-1/2 rounded-xl bg-teal-50 px-4 py-3 text-xs font-extrabold text-teal-950 shadow-xl lg:bottom-5"
        >
          {toast}
        </div>
      )}
    </div>
  )
}

function Stat({ title, value, foot, accent, description, dataTestId }) {
  return (
    <div className="rounded-xl border border-white/10 bg-gradient-to-br from-[#10293a] to-[#0c2231] p-4" data-testid={dataTestId}>
      <div className="flex items-center justify-between text-[11px] text-slate-400">
        {title}
        <span aria-hidden="true">●</span>
      </div>
      <div className="mt-1 text-2xl font-black">{value}</div>
      <div className={`mt-1 text-[10px] ${accent ? 'text-mint' : 'text-slate-400'}`}>{foot}</div>
      {description && (
        <p className="mt-2 text-[9px] leading-3 text-slate-500 border-t border-white/5 pt-2">
          {description}
        </p>
      )}
    </div>
  )
}

function Room({ id, className, label, x, y, w, h }) {
  return (
    <div
      className={`room ${className}`}
      data-room-id={id}
      style={{ left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` }}
    >
      <span className="room-label">{label}</span>
    </div>
  )
}

// One solid piece of furniture, positioned from the shared layout geometry (in
// FLOOR percentages) so that what is drawn and what blocks the avatar can never
// drift apart.
function Furniture({ item }) {
  return (
    <div
      className={item.className}
      data-furniture-id={item.id}
      style={{
        left: `${item.x}%`,
        top: `${item.y}%`,
        width: `${item.w}%`,
        height: `${item.h}%`,
        ...item.style,
      }}
    />
  )
}
