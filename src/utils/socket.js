// Socket.io client service for ProxiSpeak real-time synchronization.
//
// Handles connection lifecycle, room membership, avatar position sync,
// and presence updates. Designed to be imported once and reused across
// the VirtualOffice component.
//
// Coordinate system:
// - Positions are percentages (0-100) of the floor container, matching
//   the existing frontend collision model in src/utils/collision.js
// - The server validates and clamps coordinates to 0-100 range
// - Positions are NOT geographic (not lat/lng) — they are virtual office
//   floor percentages

import { io } from 'socket.io-client'
import { getSessionToken, requestSession } from './auth.js'

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || ''

let socket = null
let listeners = new Map()

// The last room the caller asked to join, kept so an expired session can be
// re-issued transparently on reconnection without the component re-running.
let currentRoomId = null
let currentUserName = 'Guest'
let refreshingSession = false

export function getSocket() {
  return socket
}

export function isConnected() {
  return socket !== null && socket.connected
}

// Mint a fresh session for the room this module last joined and reconnect the
// existing socket with it. Serialized by `refreshingSession` so a burst of
// reconnect attempts cannot mint several sessions.
// A failed handshake used to be dropped entirely: the handler only consulted a
// 'connect_error' listener that connect() never registers, while the caller's
// third argument is stored under 'error'. The UI therefore never learned that a
// token was rejected (no toast, no auth message). Both are notified now.
function reportConnectionError(error) {
  listeners.get('connect_error')?.forEach(fn => fn(error))
  listeners.get('error')?.forEach(fn => fn(error))
}

async function refreshSession() {
  if (!currentRoomId || refreshingSession || !socket) return false
  refreshingSession = true
  try {
    const session = await requestSession({ roomId: currentRoomId, name: currentUserName })
    if (!socket) return false
    socket.auth = { token: session.token }
    // The server may not have dropped the old connection yet (it emits
    // session:expired, then disconnects a moment later). Calling connect() while
    // still connected is a no-op, and a server-initiated disconnect disables
    // automatic reconnection — so close the local end first, then reconnect with
    // the fresh token.
    if (socket.connected) socket.disconnect()
    socket.connect()
    return true
  } catch {
    return false
  } finally {
    refreshingSession = false
  }
}

export function connect(onConnect, onDisconnect, onError) {
  if (socket) {
    socket.disconnect()
  }

  const token = getSessionToken()
  socket = io(SOCKET_URL, {
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 10000,
    transports: ['websocket', 'polling'],
    // Server-verified session. The socket is rejected before any handler runs if
    // this token is missing, expired, or has an invalid signature.
    auth: token ? { token } : {},
  })

  socket.on('connect', () => {
    listeners.get('connect')?.forEach(fn => fn())
  })

  socket.on('disconnect', (reason) => {
    listeners.get('disconnect')?.forEach(fn => fn(reason))
  })

  // An expired session is recoverable: mint a fresh token for the same room and
  // reconnect once. Invalid signatures or malformed tokens are not retried in a
  // loop; they surface to the caller.
  socket.on('connect_error', async (error) => {
    const code = error?.data?.code
    const recoverable = code === 'AUTH_EXPIRED' || code === 'AUTH_NOT_YET_VALID'
    if (recoverable && (await refreshSession())) return
    reportConnectionError(error)
  })

  // The server disconnects a socket when its token expires (not only at the
  // handshake). Mint a fresh session and reconnect so a long-lived tab does not
  // silently go offline at the TTL boundary.
  socket.on('session:expired', async (data) => {
    listeners.get('session:expired')?.forEach(fn => fn(data))
    await refreshSession()
  })

  socket.on('office:left', (data) => {
    listeners.get('office:left')?.forEach(fn => fn(data))
  })

  socket.on('error', (data) => {
    listeners.get('error')?.forEach(fn => fn(data))
  })

  // Presence events
  socket.on('office:joined', (data) => {
    listeners.get('office:joined')?.forEach(fn => fn(data))
  })

  socket.on('presence:list', (data) => {
    listeners.get('presence:list')?.forEach(fn => fn(data))
  })

  socket.on('presence:joined', (user) => {
    listeners.get('presence:joined')?.forEach(fn => fn(user))
  })

  socket.on('presence:left', (data) => {
    listeners.get('presence:left')?.forEach(fn => fn(data))
  })

  // Position and speaking events
  socket.on('position:update', (data) => {
    listeners.get('position:update')?.forEach(fn => fn(data))
  })

  socket.on('speaking:update', (data) => {
    listeners.get('speaking:update')?.forEach(fn => fn(data))
  })

  if (onConnect) listeners.set('connect', [onConnect])
  if (onDisconnect) listeners.set('disconnect', [onDisconnect])
  if (onError) listeners.set('error', [onError])

  return socket
}

export function disconnect() {
  if (socket) {
    socket.disconnect()
    socket = null
    listeners.clear()
  }
  currentRoomId = null
  currentUserName = 'Guest'
  refreshingSession = false
}

export function joinRoom(roomId, userName) {
  currentRoomId = typeof roomId === 'string' ? roomId.trim() : null
  currentUserName = userName || 'Guest'
  if (!socket || !socket.connected) return false
  // The display name is part of the signed session, so it is not sent here: the
  // server binds identity to the verified token, not to this payload.
  socket.emit('office:join', { roomId: currentRoomId })
  return true
}

export function leaveRoom() {
  if (!socket || !socket.connected) return
  socket.emit('office:leave')
}

export function updatePosition(x, y) {
  if (!socket || !socket.connected) return
  socket.emit('position:update', { x, y })
}

export function updateSpeaking(speaking) {
  if (!socket || !socket.connected) return
  socket.emit('speaking:update', speaking)
}

export function on(event, callback) {
  if (!listeners.has(event)) {
    listeners.set(event, [])
  }
  listeners.get(event).push(callback)
  return () => {
    const cbs = listeners.get(event)
    if (cbs) {
      const idx = cbs.indexOf(callback)
      if (idx !== -1) cbs.splice(idx, 1)
    }
  }
}

export function off(event, callback) {
  const cbs = listeners.get(event)
  if (cbs) {
    const idx = cbs.indexOf(callback)
    if (idx !== -1) cbs.splice(idx, 1)
  }
}
