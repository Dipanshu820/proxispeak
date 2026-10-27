// WebRTC signaling for ProxiSpeak proximity audio.
//
// Handles SDP exchange and ICE candidate signaling via Socket.io.
// Peer connections are established directly between clients (P2P mesh).
//
// Architecture:
// - Each client creates a peer connection to every other user in the room
// - Signaling is coordinated through the Socket.io server
// - Audio volume is adjusted based on proximity (distance between avatars)
//
// Limitations:
// - Mesh topology: O(n²) connections, suitable for small rooms (<10 users)
// - For larger rooms, consider SFU (Selective Forwarding Unit) architecture
// - No media recording or storage - audio stays peer-to-peer only

// Maximum allowed size (in bytes) for signaling payloads (SDP offer/answer and
// ICE candidates). SDP blobs can be large but rarely exceed a few KiB; a 64 KiB
// cap protects against a malicious or buggy client flooding the relay.
const MAX_SIGNALING_PAYLOAD = 64 * 1024

// Per-socket ceiling on signaling events. A client can otherwise flood the relay
// with offers/answers/candidates. 120 events per 10 s is far above a normal
// handshake (a few dozen candidates) and far below a flood.
const SIGNALING_WINDOW_MS = 10_000
const SIGNALING_MAX_EVENTS = 120
const signalingRate = new Map()

function allowSignaling(socket) {
  const now = Date.now()
  const entry = signalingRate.get(socket.id)
  if (!entry || now - entry.start > SIGNALING_WINDOW_MS) {
    signalingRate.set(socket.id, { start: now, count: 1 })
    return true
  }
  if (entry.count >= SIGNALING_MAX_EVENTS) return false
  entry.count += 1
  return true
}

// Reject oversized signaling payloads before relaying.
function rejectIfOversized(socket, data, field, code) {
  const value = data[field]
  if (value && Buffer.byteLength(String(value)) > MAX_SIGNALING_PAYLOAD) {
    socket.emit('error', { code })
    return true
  }
  return false
}

// Track active peer connections per socket
const peerConnections = new Map() // socketId -> Map<remoteSocketId, RTCPeerConnection>

// Pending offers, keyed `${offererSocketId}:${answererSocketId}`.
//
// This must be a set of directed offers, not one mutable state per pair. When two
// peers offer at the same time (glare, or a reconnect that races the surviving
// peer) both offers exist simultaneously, and one of them will be answered while
// the other is ignored by the impolite peer. An earlier Map stored a single
// offer/answer value per pair, so recording one direction silently overwrote the
// other and the legitimate answer was rejected with NO_SIGNALING_STATE — leaving
// the connection stuck in have-local-offer. The set keeps both directions, and an
// answer consumes only the exchange it actually answers.
const pendingOffers = new Set()

function recordOffer(offerer, answerer) {
  pendingOffers.add(`${offerer}:${answerer}`)
}

function hasPendingOffer(offerer, answerer) {
  return pendingOffers.has(`${offerer}:${answerer}`)
}

function consumeOffer(offerer, answerer) {
  pendingOffers.delete(`${offerer}:${answerer}`)
  // The reverse offer, if any, was the colliding one and is no longer relevant.
  pendingOffers.delete(`${answerer}:${offerer}`)
}

function clearSocketSignalingState(socketId) {
  for (const key of pendingOffers) {
    if (key.startsWith(`${socketId}:`) || key.endsWith(`:${socketId}`)) {
      pendingOffers.delete(key)
    }
  }
}

// Signaling is only accepted from sockets that completed the authenticated
// handshake. server.js installs the `io.use()` verifier that sets
// socket.data.session; this guard keeps the signaling module safe on its own (and
// documents the requirement at the point where it is enforced).
function rejectUnlessAuthenticated(socket) {
  if (socket.data?.session) return false
  socket.emit('error', { code: 'AUTH_REQUIRED' })
  return true
}

export function initWebRTCSignaling(io) {
  io.on('connection', (socket) => {
    // Request to initiate a peer connection with another user
    socket.on('webrtc:initiate', (data = {}) => {
      if (rejectUnlessAuthenticated(socket)) return
      if (!allowSignaling(socket)) {
        socket.emit('error', { code: 'RATE_LIMITED' })
        return
      }
      const { targetSocketId } = data
      if (!targetSocketId || typeof targetSocketId !== 'string') {
        socket.emit('error', { code: 'INVALID_TARGET' })
        return
      }

      // Same-room authorization: a socket may only invite peers that share its
      // room. Without this, any connected client could probe/invite any other
      // socket on the server, including sockets in rooms it never joined.
      const emitterRoom = socket.data.roomId
      if (!emitterRoom) {
        socket.emit('error', { code: 'NOT_IN_SAME_ROOM' })
        return
      }

      // Check if target is still connected
      const targetSocket = io.sockets.sockets.get(targetSocketId)
      if (!targetSocket || !targetSocket.connected) {
        socket.emit('error', { code: 'USER_OFFLINE' })
        return
      }
      if (targetSocket.data.roomId !== emitterRoom) {
        socket.emit('error', { code: 'NOT_IN_SAME_ROOM' })
        return
      }
      if (!targetSocket.data.session) {
        socket.emit('error', { code: 'USER_OFFLINE' })
        return
      }

      // `webrtc:initiate` is only an invitation: no answer is expected in reply,
      // so it records no pending offer. The real offer (`webrtc:offer`) does.

      // Forward initiation request to target
      targetSocket.emit('webrtc:invite', {
        from: socket.id,
        roomId: socket.data.roomId,
        userId: socket.data.user?.id || socket.id,
        userName: socket.data.user?.name || 'Unknown',
      })
    })

    // Relay an initiator's SDP offer to the target peer
    socket.on('webrtc:offer', (data = {}) => {
    if (rejectUnlessAuthenticated(socket)) return
    if (!allowSignaling(socket)) {
      socket.emit('error', { code: 'RATE_LIMITED' })
      return
    }
    const { targetSocketId, sdp } = data
    if (!targetSocketId || typeof targetSocketId !== 'string') {
      socket.emit('error', { code: 'INVALID_TARGET' })
      return
    }
    if (!sdp) {
      socket.emit('error', { code: 'INVALID_SDP' })
      return
    }

    // Payload-size guard
    if (rejectIfOversized(socket, data, 'sdp', 'SIGNALING_PAYLOAD_TOO_LARGE')) return

    // Same-room authorization: the emitter and target must share the same room.
    // Rooms are the only authorization boundary that exists in Phase 3.
    const emitterRoom = socket.data.roomId
    if (!emitterRoom) {
      socket.emit('error', { code: 'NOT_IN_SAME_ROOM' })
      return
    }

    const targetSocket = io.sockets.sockets.get(targetSocketId)
    if (!targetSocket || !targetSocket.connected) {
      socket.emit('error', { code: 'USER_OFFLINE' })
      return
    }
    if (targetSocket.data.roomId !== emitterRoom) {
      socket.emit('error', { code: 'NOT_IN_SAME_ROOM' })
      return
    }

    // Record the directed offer. A crossing offer from the target is recorded
    // separately and cannot overwrite this one.
    recordOffer(socket.id, targetSocketId)

    // Forward the offer to the target as an invitation
    targetSocket.emit('webrtc:invite', {
      from: socket.id,
      sdp,
      roomId: emitterRoom,
      userId: socket.data.user?.id || socket.id,
      userName: socket.data.user?.name || 'Unknown',
    })
  })

    // Relay a responder's SDP answer back to the initiator.
    //
    // `fromSocketId` is the socket being ANSWERED, i.e. the initiator — it is the
    // `from` field of the webrtc:invite the answerer received, and it is what the
    // client sends (src/utils/webrtc.js -> acceptPeerConnection). The answer is
    // forwarded to that socket, so this is the only consistent meaning of the
    // field. (An earlier revision compared it to socket.id, which rejected every
    // real answer and made the handshake impossible to complete.)
    socket.on('webrtc:accept', (data = {}) => {
    if (rejectUnlessAuthenticated(socket)) return
    if (!allowSignaling(socket)) {
      socket.emit('error', { code: 'RATE_LIMITED' })
      return
    }
    const { fromSocketId, sdp } = data
    if (!fromSocketId || typeof fromSocketId !== 'string' || !sdp) {
      socket.emit('error', { code: 'INVALID_REQUEST' })
      return
    }

    // Payload-size guard
    if (rejectIfOversized(socket, data, 'sdp', 'SIGNALING_PAYLOAD_TOO_LARGE')) return

    // A socket cannot answer itself.
    if (socket.id === fromSocketId) {
      socket.emit('error', { code: 'INVALID_REQUEST' })
      return
    }

    // Signaling-state consistency guard: the server must have recorded an offer
    // FROM fromSocketId TO this socket. This is what prevents a third socket from
    // injecting an answer into an exchange it was never part of, and it replaces
    // the old "socket.id === fromSocketId" check, which conflated "who I am" with
    // "who I am answering".
    if (!hasPendingOffer(fromSocketId, socket.id)) {
      socket.emit('error', { code: 'NO_SIGNALING_STATE' })
      return
    }
    consumeOffer(fromSocketId, socket.id)

    // Same-room authorization: the emitter and the initiator must share the same
    // room.
    const emitterRoom = socket.data.roomId
    if (!emitterRoom) {
      socket.emit('error', { code: 'NOT_IN_SAME_ROOM' })
      return
    }
    const initiatorSocket = io.sockets.sockets.get(fromSocketId)
    if (!initiatorSocket || initiatorSocket.data.roomId !== emitterRoom) {
      socket.emit('error', { code: 'NOT_IN_SAME_ROOM' })
      return
    }

    // Forward acceptance to the initiator. `from` is the answerer (this socket).
    initiatorSocket.emit('webrtc:accepted', {
      from: socket.id,
      sdp,
      roomId: emitterRoom,
    })
  })

    // Handle ICE candidate exchange
    socket.on('webrtc:ice-candidate', (data = {}) => {
    if (rejectUnlessAuthenticated(socket)) return
    if (!allowSignaling(socket)) {
      socket.emit('error', { code: 'RATE_LIMITED' })
      return
    }
    const { targetSocketId, candidate, sdpMid, sdpMLineIndex } = data
    if (!targetSocketId || !candidate) {
      socket.emit('error', { code: 'INVALID_CANDIDATE' })
      return
    }

    // Payload-size guard for the candidate string
    if (rejectIfOversized(socket, data, 'candidate', 'SIGNALING_PAYLOAD_TOO_LARGE')) return

    // Same-room authorization: ICE candidates are part of signaling, so they are
    // subject to the same room boundary as offers and answers. Candidates carry
    // host/srflx addresses, so relaying them across rooms would leak network
    // information to sockets that were never authorized to talk to each other.
    const emitterRoom = socket.data.roomId
    if (!emitterRoom) {
      socket.emit('error', { code: 'NOT_IN_SAME_ROOM' })
      return
    }

    const targetSocket = io.sockets.sockets.get(targetSocketId)
    if (!targetSocket || !targetSocket.connected) {
      socket.emit('error', { code: 'USER_OFFLINE' })
      return
    }
    if (targetSocket.data.roomId !== emitterRoom) {
      socket.emit('error', { code: 'NOT_IN_SAME_ROOM' })
      return
    }

    targetSocket.emit('webrtc:ice-candidate', {
      from: socket.id,
      candidate,
      sdpMid,
      sdpMLineIndex,
    })
  })

    // Handle disconnect cleanup
    socket.on('disconnect', () => {
    // Clean up peer connections for this socket
    const peers = peerConnections.get(socket.id)
    if (peers) {
      for (const [remoteId, pc] of peers) {
        pc.close()
        // Notify the remote peer
        const remoteSocket = io.sockets.sockets.get(remoteId)
        if (remoteSocket?.connected) {
          remoteSocket.emit('webrtc:peer-disconnected', { from: socket.id })
        }
      }
      peerConnections.delete(socket.id)
    }

      // Clean up pending offers involving this socket
      clearSocketSignalingState(socket.id)

      // Release the per-socket rate-limit bucket
      signalingRate.delete(socket.id)
    })
  })
}

// Get or create a peer connection for a socket pair
export function getPeerConnection(socketId, remoteSocketId, config = {}) {
  // Get or create the peer map for this socket
  if (!peerConnections.has(socketId)) {
    peerConnections.set(socketId, new Map())
  }
  const peerMap = peerConnections.get(socketId)

  // Return existing connection if available
  if (peerMap.has(remoteSocketId)) {
    return peerMap.get(remoteSocketId)
  }

  // Create new peer connection
  const pc = createPeerConnection(remoteSocketId, config)
  peerMap.set(remoteSocketId, pc)
  return pc
}

// Create a new RTCPeerConnection
function createPeerConnection(remoteSocketId, config = {}) {
  const {
    iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
    proxispeakConfig = {
      proximityEarshotPx: 100,
      minVolume: 0.1,
    },
  } = config

  const pc = new RTCPeerConnection({ iceServers })

  // Store reference to config for volume calculations
  pc.proxispeakConfig = proxispeakConfig
  pc.remoteSocketId = remoteSocketId

  return pc
}

// Calculate audio volume based on proximity
export function calculateProximityVolume(localX, localY, remoteX, remoteY, config = {}) {
  const {
    earshotPx = 100,
    minVolume = 0.1,
    maxVolume = 1.0,
  } = config

  // Calculate pixel distance (assuming same floor dimensions)
  const dx = remoteX - localX
  const dy = remoteY - localY
  const distancePx = Math.sqrt(dx * dx + dy * dy)

  // Calculate volume: 1.0 at distance 0, fading to minVolume at earshot distance
  if (distancePx >= earshotPx) {
    return 0  // Outside earshot - no audio
  }

  // Linear volume falloff from 1.0 to minVolume
  const volumeRatio = 1 - (distancePx / earshotPx)
  const volume = minVolume + (maxVolume - minVolume) * volumeRatio

  return Math.max(0, Math.min(1, volume))
}

// Apply volume to a remote audio track
export function setRemoteTrackVolume(audioTrack, volume) {
  if (!audioTrack) return

  // Gain node to control volume
  const gainNode = audioTrack._gainNode
  if (!gainNode) {
    // Create gain node and connect it
    const ctx = new AudioContext()
    const gain = ctx.createGain()
    gain.gain.value = volume
    gain.connect(ctx.destination)

    // Store reference for later volume changes
    audioTrack._gainNode = gain
    audioTrack._audioContext = ctx
  } else {
    gainNode.gain.setValueAtTime(volume, audioTrack._gainNode.context.currentTime)
  }
}

// Clean up peer connections for a socket
export function cleanupPeerConnections(socketId) {
  const peers = peerConnections.get(socketId)
  if (peers) {
    for (const [, pc] of peers) {
      pc.close()
    }
    peers.clear()
  }
  peerConnections.delete(socketId)
}

// Get stats for monitoring
export function getSignalingStats() {
  const stats = {
    active_connections: 0,
    sockets_with_peers: peerConnections.size,
  }

  for (const [, peers] of peerConnections) {
    stats.active_connections += peers.size
  }

  return stats
}
