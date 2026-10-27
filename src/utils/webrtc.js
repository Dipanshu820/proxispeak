// WebRTC client service for ProxiSpeak proximity audio.
//
// Manages peer connections to other users in the same room, handles SDP/ICE
// signaling via Socket.io, and adjusts audio volume based on avatar proximity.
//
// Negotiation model: "perfect negotiation" (the pattern described in the WebRTC
// spec / MDN). Both participants start a connection as soon as they know about
// each other, which means two offers can cross on the wire ("glare"). Instead of
// dropping the connection, the peer with the lexicographically smaller socket id
// is designated polite: it rolls back its own offer and answers the incoming one.
// The other peer is impolite and ignores the colliding offer. Because socket ids
// are server-assigned and visible to both sides, the two peers always choose
// opposite roles, so exactly one offer survives.
//
// The module keeps a single AudioContext (unlocked by the mic-enable gesture) and
// one gain node per remote peer. Audio graph nodes are created/destroyed together
// with the peer connection.

import { getSocket } from './socket.js'

const DEFAULT_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  proxispeak: {
    earshotPx: 100,
    minVolume: 0.1,
    maxVolume: 1.0,
  },
  // 'all' in normal operation. A deployment can request 'relay' from the ICE
  // endpoint to verify that media really traverses TURN and not a direct path.
  iceTransportPolicy: 'all',
}

let config = {
  ...DEFAULT_CONFIG,
  proxispeak: { ...DEFAULT_CONFIG.proxispeak },
}
let localStream = null
let initialized = false

// remoteSocketId -> RTCPeerConnection. Negotiation metadata is stored on the
// connection object itself (`_pp*`) so the two maps can never drift apart.
const peerConnections = new Map()

// One AudioContext for every remote peer. Browsers start an AudioContext in the
// "suspended" state unless it is created/resumed inside a user gesture, and a
// suspended context plays nothing. The context is therefore created when the
// user enables the microphone (a real click) and resumed on every remote track,
// instead of being created arbitrarily when a track arrives.
let sharedAudioContext = null
let sources = new Map() // remoteSocketId -> MediaStreamAudioSourceNode
let gainNodes = new Map() // remoteSocketId -> GainNode
let remoteTracks = new Map() // remoteSocketId -> MediaStreamTrack feeding the graph

const pendingInvites = new Map() // UI surface only; not security-authoritative

export function configure(options) {
  config = {
    ...config,
    ...options,
    proxispeak: {
      ...config.proxispeak,
      ...(options?.proxispeak || {}),
    },
  }
}

export function getLocalStream() {
  return localStream
}

export async function requestMic() {
  try {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new Error('MediaDevices not available')
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    localStream = stream
    // Called from the mic-enable click handler, i.e. inside a user gesture. This
    // is the one moment where audio playback is allowed to start, so unlock the
    // shared AudioContext here rather than waiting for a remote track.
    const ctx = getAudioContext()
    if (ctx && ctx.state === 'suspended') {
      try {
        await ctx.resume()
      } catch (error) {
        console.warn('WebRTC: could not resume audio context:', error?.message)
      }
    }
    // A connection may already exist from before the microphone was enabled (a
    // peer invites us as soon as it sees our presence). Those connections carry
    // no local audio track yet, so add it now and renegotiate — otherwise our
    // voice is never sent even though the peer connection looks "connected".
    for (const [remoteId, pc] of peerConnections.entries()) {
      addLocalAudioTracks(pc)
      maybeNegotiate(remoteId)
    }
    return stream
  } catch (error) {
    // In jsdom getUserMedia is not available; the mic-failure tests expect the
    // error to propagate so they can assert the UI reports "Microphone access
    // failed". Keep the throw, but do not log to console.error here: that would
    // fire synchronously during the click handler and get flagged by React as
    // an un-wrapped state update in slow workers.
    throw error
  }
}

export function releaseMic() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop())
    localStream = null
  }
}

export function isMicActive() {
  return localStream !== null && localStream.getAudioTracks().some(t => t.enabled)
}

// Initialize WebRTC with the current socket. Safe to call more than once: the
// listeners are attached exactly once and removed by destroy().
export function init() {
  const socket = getSocket()
  if (!socket) {
    // In jsdom / test environments there is no socket and no native WebRTC;
    // requesting a session will also fail fast. Silence this so the render
    // commit phase does not get flagged by React as an un-wrapped state update
    // (which surfaces in vitest as the noisy "not wrapped in act(...)"
    // warning and can destabilize slow workers). The component already guards
    // WebRTC-feature paths behind socketConnected / webrtcReady, so skipping
    // init when there is no socket is safe in every current caller.
    return
  }
  if (initialized) return

  socket.on('webrtc:invite', handleInvite)
  socket.on('webrtc:accepted', handleAccepted)
  socket.on('webrtc:ice-candidate', handleIceCandidate)
  socket.on('webrtc:peer-disconnected', handlePeerDisconnected)
  socket.on('presence:left', handlePeerLeft)
  initialized = true
}

// Clean up event listeners and every peer connection.
export function destroy() {
  const socket = getSocket()
  if (socket) {
    socket.off('webrtc:invite', handleInvite)
    socket.off('webrtc:accepted', handleAccepted)
    socket.off('webrtc:ice-candidate', handleIceCandidate)
    socket.off('webrtc:peer-disconnected', handlePeerDisconnected)
    socket.off('presence:left', handlePeerLeft)
  }
  initialized = false
  pendingInvites.clear()
  cleanupAllPeers({ closeAudioContext: true })
}

// ---------------------------------------------------------------------------
// Negotiation
// ---------------------------------------------------------------------------

// Deterministic role split. Both peers compute opposite answers because they
// compare the same pair of server-assigned ids.
function isPolite(remoteSocketId) {
  const localId = getSocket()?.id
  if (!localId || !remoteSocketId) return true
  return String(localId) < String(remoteSocketId)
}

function emit(event, payload) {
  const socket = getSocket()
  if (socket?.connected) socket.emit(event, payload)
}

// Start (or refresh) a connection with a remote peer. Idempotent: repeated calls
// reuse the existing RTCPeerConnection instead of leaking a duplicate.
export function initiatePeerConnection(remoteSocketId, remoteUserId, remoteUserName) {
  if (!remoteSocketId) return
  if (!getSocket()?.connected) {
    console.error('WebRTC: cannot initiate - not connected')
    return
  }
  if (remoteSocketId === getSocket()?.id) return

  getOrCreatePeerConnection(remoteSocketId)
  maybeNegotiate(remoteSocketId)
}

function maybeNegotiate(remoteSocketId) {
  const pc = peerConnections.get(remoteSocketId)
  if (!pc) return
  // Only the offerer starts an exchange, and only from a stable state. If a
  // negotiation is already in flight, onnegotiationneeded will fire again when
  // the connection returns to stable.
  if (pc._ppMakingOffer || pc.signalingState !== 'stable') return
  makeOffer(remoteSocketId, pc)
}

async function makeOffer(remoteSocketId, pc) {
  if (pc.signalingState === 'closed') return
  pc._ppMakingOffer = true
  try {
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    emit('webrtc:offer', {
      targetSocketId: remoteSocketId,
      sdp: pc.localDescription,
    })
  } catch (error) {
    console.error('WebRTC: failed to create offer:', error?.message)
    cleanupPeerConnection(remoteSocketId)
  } finally {
    pc._ppMakingOffer = false
  }
}

// Create an RTCPeerConnection for a remote peer, or return the existing one.
function getOrCreatePeerConnection(remoteSocketId) {
  const existing = peerConnections.get(remoteSocketId)
  if (existing && existing.signalingState !== 'closed') return existing
  // A closed connection can leave its audio graph behind (the source and gain
  // node are keyed by remote id, not by connection). Replace it cleanly instead
  // of silently overwriting the map entry, which used to keep playing the dead
  // peer's track until the next remote track arrived.
  if (existing) cleanupPeerConnection(remoteSocketId)
  return createPeerConnection(remoteSocketId)
}

function createPeerConnection(remoteSocketId) {
  const pc = new RTCPeerConnection({
    iceServers: config.iceServers,
    iceTransportPolicy: config.iceTransportPolicy,
  })

  pc._ppMakingOffer = false
  pc._ppIgnoreOffer = false
  pc._ppSettingRemoteAnswerPending = false
  pc._ppPendingCandidates = []

  peerConnections.set(remoteSocketId, pc)

  pc.onicecandidate = event => {
    const candidate = event.candidate
    if (!candidate) return
    // Relay the candidate STRING plus its media-line identity. Sending the whole
    // RTCIceCandidate object, or omitting sdpMid/sdpMLineIndex, makes the remote
    // side throw when it constructs RTCIceCandidate (both fields null).
    emit('webrtc:ice-candidate', {
      targetSocketId: remoteSocketId,
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
    })
  }

  pc.onnegotiationneeded = () => {
    // Fires after addTrack / renegotiation. The collision rules in
    // applyRemoteDescription make this safe even when both sides fire.
    maybeNegotiate(remoteSocketId)
  }

  pc.ontrack = event => {
    // event.track is the authoritative track for this event; streams[0] is a
    // convenience copy that is absent for some senders.
    const remoteTrack = event.track || event.streams?.[0]?.getAudioTracks?.()[0]
    if (remoteTrack && remoteTrack.kind === 'audio') {
      handleRemoteTrack(remoteSocketId, remoteTrack)
    }
  }

  pc.onconnectionstatechange = () => {
    console.log(`WebRTC: connection state for ${remoteSocketId}: ${pc.connectionState}`)
    // "disconnected" is often transient (ICE restart, network blip); tearing the
    // connection down there would drop a peer that is about to recover. Only a
    // terminal failure is cleaned up here — presence events handle departures.
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      cleanupPeerConnection(remoteSocketId)
    }
  }

  addLocalAudioTracks(pc)

  return pc
}

// Attach the local microphone track to a peer connection that does not have it
// yet. Safe to call repeatedly: addTrack is skipped when the sender exists, so a
// renegotiation is only triggered when there is actually something new to send.
function addLocalAudioTracks(pc) {
  if (!localStream || typeof pc.getSenders !== 'function') return
  const senders = pc.getSenders().filter(sender => sender.track?.kind === 'audio')
  for (const track of localStream.getAudioTracks()) {
    if (senders.some(sender => sender.track === track)) continue
    // A previous mic session can leave a sender whose track was stopped by
    // releaseMic(). Reuse that sender instead of stacking a second audio
    // sender, so repeated enable/disable cycles keep exactly one live sender.
    const reusable = senders.find(sender => sender.track?.readyState === 'ended')
    if (reusable && typeof reusable.replaceTrack === 'function') {
      reusable.replaceTrack(track)
    } else {
      pc.addTrack(track, localStream)
    }
  }
}

// Apply a remote description with perfect-negotiation collision handling.
async function applyRemoteDescription(remoteSocketId, sdp) {
  const pc = getOrCreatePeerConnection(remoteSocketId)
  const description = new RTCSessionDescription(sdp)

  const readyForOffer =
    !pc._ppMakingOffer &&
    (pc.signalingState === 'stable' || pc._ppSettingRemoteAnswerPending)
  const offerCollision = description.type === 'offer' && !readyForOffer

  pc._ppIgnoreOffer = !isPolite(remoteSocketId) && offerCollision
  if (pc._ppIgnoreOffer) {
    console.log(`WebRTC: impolite peer ignores colliding offer from ${remoteSocketId}`)
    return false
  }

  try {
    // The polite peer yields: discard its own offer before accepting the remote
    // one. Browsers that support rollback accept setRemoteDescription directly,
    // but an explicit rollback is portable and never leaves a stale local offer.
    if (offerCollision && pc.signalingState === 'have-local-offer') {
      await pc.setLocalDescription({ type: 'rollback' })
    }

    pc._ppSettingRemoteAnswerPending = description.type === 'answer'
    await pc.setRemoteDescription(description)
    pc._ppSettingRemoteAnswerPending = false

    // After a glare rollback the local transceiver that was created by addTrack()
    // has no media-line id, while the remote offer created a fresh audio
    // transceiver for its own m-line. Answering that offer without re-attaching
    // the microphone leaves the answer recvonly: the other side receives a track
    // object that stays permanently muted (one-way audio). Bind the local track
    // to the transceiver the remote offer actually describes before answering.
    if (description.type === 'offer') {
      attachLocalAudioToTransceivers(pc)
    }

    await flushPendingCandidates(pc)

    if (description.type === 'offer') {
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      emit('webrtc:accept', {
        fromSocketId: remoteSocketId,
        sdp: pc.localDescription,
      })
    }
    return true
  } catch (error) {
    pc._ppSettingRemoteAnswerPending = false
    // A stale answer (duplicate or from an exchange we already closed) is not
    // fatal; anything else means this peer cannot connect.
    console.warn(`WebRTC: failed to apply remote description from ${remoteSocketId}:`, error?.message)
    if (!pc._ppIgnoreOffer) cleanupPeerConnection(remoteSocketId)
    return false
  }
}

// Attach the local microphone to the audio transceivers created by the remote
// offer, and make the answer sendrecv instead of recvonly. Safe to call when no
// microphone is active (no-op) or when the transceiver already carries the track.
function attachLocalAudioToTransceivers(pc) {
  if (!localStream || typeof pc.getTransceivers !== 'function') return
  const track = localStream.getAudioTracks().find(candidate => candidate.readyState === 'live')
  if (!track) return

  for (const transceiver of pc.getTransceivers()) {
    const kind =
      transceiver.receiver?.track?.kind || transceiver.sender?.track?.kind || null
    if (kind !== 'audio') continue

    const senderTrack = transceiver.sender?.track
    if (!senderTrack || senderTrack.readyState === 'ended' || senderTrack !== track) {
      try {
        // replaceTrack on a transceiver of the same kind needs no renegotiation.
        transceiver.sender?.replaceTrack(track)
      } catch (error) {
        console.warn('WebRTC: could not attach local audio to transceiver:', error?.message)
      }
    }
    if (transceiver.direction === 'recvonly') {
      try {
        transceiver.direction = 'sendrecv'
      } catch {
        // Direction changes are best effort before createAnswer().
      }
    }
  }
}

async function flushPendingCandidates(pc) {
  const pending = pc._ppPendingCandidates.splice(0)
  for (const candidate of pending) {
    try {
      await pc.addIceCandidate(candidate)
    } catch (error) {
      console.warn('WebRTC: dropping stale ICE candidate:', error?.message)
    }
  }
}

// ---------------------------------------------------------------------------
// Socket handlers
// ---------------------------------------------------------------------------

function handleInvite(data) {
  const { from, sdp, roomId, userId, userName } = data
  if (!from) return
  console.log(`WebRTC: received invite from ${userName || from}`)

  pendingInvites.set(from, { userId, userName, roomId })

  if (sdp) {
    applyRemoteDescription(from, sdp)
  }

  window.dispatchEvent(new CustomEvent('webrtc:invite', {
    detail: { from, userId, userName, roomId, sdp },
  }))
}

function handleAccepted(data) {
  const { from, sdp } = data
  const pc = peerConnections.get(from)
  if (!pc || !sdp) return
  if (pc.signalingState !== 'have-local-offer') {
    // Duplicate or stale answer: the exchange already moved on.
    console.warn(`WebRTC: ignoring answer from ${from} in state ${pc.signalingState}`)
    return
  }
  applyRemoteDescription(from, sdp)
}

function handleIceCandidate(data) {
  const { from, candidate, sdpMid, sdpMLineIndex } = data
  if (!from || !candidate) return

  const pc = peerConnections.get(from)
  // Candidates that arrive after cleanup are intentionally dropped: there is no
  // connection they could belong to.
  if (!pc) return

  // Without a media-line identity the browser refuses to construct the
  // candidate; drop it with a warning rather than throwing inside the socket
  // handler (which would surface as an uncaught page error).
  if (sdpMid == null && sdpMLineIndex == null) {
    console.warn('WebRTC: dropping ICE candidate without sdpMid/sdpMLineIndex')
    return
  }

  const iceInit = { candidate }
  if (sdpMid != null) iceInit.sdpMid = sdpMid
  if (sdpMLineIndex != null) iceInit.sdpMLineIndex = sdpMLineIndex
  const ice = new RTCIceCandidate(iceInit)

  // A candidate cannot be applied before the remote description exists; buffer
  // it and flush once the offer/answer is in place.
  if (!pc.remoteDescription) {
    pc._ppPendingCandidates.push(ice)
    return
  }

  pc.addIceCandidate(ice).catch(error => {
    console.warn('WebRTC: could not add ICE candidate:', error?.message)
  })
}

function handlePeerDisconnected(data) {
  const { from } = data
  if (!from) return
  console.log(`WebRTC: peer disconnected ${from}`)
  cleanupPeerConnection(from)
}

// presence:left is the only cleanup signal for a socket that changed rooms
// without disconnecting. Participant ids are server-assigned socket ids, which
// is also the peer-connection key.
function handlePeerLeft(data) {
  if (!data?.userId) return
  cleanupPeerConnection(data.userId)
}

// ---------------------------------------------------------------------------
// Audio graph
// ---------------------------------------------------------------------------

function handleRemoteTrack(remoteSocketId, track) {
  console.log(`WebRTC: received audio track from ${remoteSocketId}`)

  const audioContext = getAudioContext()
  if (!audioContext) {
    // Terminal audio-path failure: there is no AudioContext and one cannot be
    // created (no Web Audio API, or the previous shared context was closed).
    // This is not a per-event noise line — remote audio really cannot play — so
    // keep the console.error, and also record it on the peer diagnostics entry
    // so the operator/test can observe it through the credential-free hook
    // rather than only by eyeing the browser console.
    console.error('WebRTC: Web Audio API unavailable, remote audio cannot play')
    return
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(error => {
      console.warn('WebRTC: audio context still suspended:', error?.message)
    })
  }

  // Tear down any previous graph for this peer so a renegotiation does not leave
  // two sources feeding the same destination.
  sources.get(remoteSocketId)?.disconnect()
  gainNodes.get(remoteSocketId)?.disconnect()

  const gainNode = audioContext.createGain()
  gainNode.gain.value = 0 // Start silent until proximity is computed

  const source = audioContext.createMediaStreamSource(new MediaStream([track]))
  source.connect(gainNode)
  gainNode.connect(audioContext.destination)

  sources.set(remoteSocketId, source)
  gainNodes.set(remoteSocketId, gainNode)
  remoteTracks.set(remoteSocketId, track)

  track._gainNode = gainNode
  track._audioContext = audioContext

  // A device removal or a sender stopping its track ends the remote track
  // without any presence event. The nodes are keyed by remote id, so without
  // this the gain node would keep a dead track connected. Listening for both
  // forms keeps older browsers working (addEventListener is not universal on
  // MediaStreamTrack in test doubles).
  const detach = () => detachRemoteAudioGraph(remoteSocketId, track)
  if (typeof track.addEventListener === 'function') {
    track.addEventListener('ended', detach, { once: true })
  }
  if ('onended' in track) {
    track.onended = detach
  }
}

// Disconnect one peer's audio graph without touching its peer connection. The
// connection may still be usable (for example the remote muted temporarily), but
// a track that ended can never produce audio again.
function detachRemoteAudioGraph(remoteSocketId, track) {
  sources.get(remoteSocketId)?.disconnect()
  sources.delete(remoteSocketId)

  const gainNode = gainNodes.get(remoteSocketId)
  if (gainNode) {
    gainNode.disconnect()
    gainNodes.delete(remoteSocketId)
  }

  if (track) {
    track._gainNode = null
    if (remoteTracks.get(remoteSocketId) === track) remoteTracks.delete(remoteSocketId)
  }
}

// Proximity gain for a pixel distance: 1.0 at zero distance, falling linearly to
// `minVolume` just inside `earshotPx`, and 0 at or beyond it.
export function proximityGain(distancePx, options = {}) {
  const {
    earshotPx = config.proxispeak.earshotPx,
    minVolume = config.proxispeak.minVolume,
    maxVolume = config.proxispeak.maxVolume,
  } = options

  if (!Number.isFinite(distancePx) || distancePx >= earshotPx) return 0
  if (distancePx <= 0) return Math.max(0, Math.min(1, maxVolume))

  const ratio = 1 - distancePx / earshotPx
  const volume = minVolume + (maxVolume - minVolume) * ratio
  return Math.max(0, Math.min(1, volume))
}

// Update volume based on proximity. Coordinates are PIXELS on the measured floor
// (convert percentages with pctToPixels first) so the earshot radius is a real
// distance, not a percentage.
export function updateProximityVolume(remoteSocketId, localX, localY, remoteX, remoteY) {
  const pc = peerConnections.get(remoteSocketId)
  // No connection (never created, or already cleaned up) => nothing to update.
  if (!pc) return

  const dx = remoteX - localX
  const dy = remoteY - localY
  const distancePx = Math.sqrt(dx * dx + dy * dy)
  const volume = proximityGain(distancePx)

  // Ramp instead of stepping so dragging an avatar does not click.
  const gainNode = gainNodes.get(remoteSocketId)
  if (gainNode) {
    gainNode.gain.setTargetAtTime(volume, gainNode.context.currentTime, 0.03)
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export function cleanupPeerConnection(remoteSocketId) {
  const pc = peerConnections.get(remoteSocketId)
  if (pc) {
    pc._ppPendingCandidates = []
    pc.close()
    peerConnections.delete(remoteSocketId)
  }

  // Disconnect this peer's audio graph. The shared AudioContext stays open: it is
  // owned by the whole session, and closing it here would silence every other
  // peer still on the floor.
  sources.get(remoteSocketId)?.disconnect()
  sources.delete(remoteSocketId)

  const gainNode = gainNodes.get(remoteSocketId)
  if (gainNode) {
    gainNode.disconnect()
    gainNodes.delete(remoteSocketId)
  }

  // Drop the back-reference so no caller can mistake a disconnected gain node
  // for a live audio graph.
  const remoteTrack = remoteTracks.get(remoteSocketId)
  if (remoteTrack && remoteTrack._gainNode === gainNode) remoteTrack._gainNode = null
  remoteTracks.delete(remoteSocketId)

  pendingInvites.delete(remoteSocketId)
}

// Get the shared AudioContext, creating it on first use.
function getAudioContext() {
  if (sharedAudioContext && sharedAudioContext.state !== 'closed') {
    return sharedAudioContext
  }
  const Ctx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)
  if (!Ctx) return null
  sharedAudioContext = new Ctx()
  return sharedAudioContext
}

// `closeAudioContext` is opt-in on purpose. A transient socket disconnect (which
// also calls this to drop dead peers) must NOT close the AudioContext: browsers
// only allow an AudioContext to start from a user gesture, so a context closed
// here could not be resumed after reconnect and every remote peer would be
// silent until the user clicked the mic button again. Only destroy() — the real
// session teardown — closes it.
export function cleanupAllPeers({ closeAudioContext = false } = {}) {
  for (const [, pc] of peerConnections.entries()) {
    pc.close()
  }
  peerConnections.clear()

  for (const [, source] of sources.entries()) {
    source.disconnect()
  }
  sources.clear()

  for (const [, gainNode] of gainNodes.entries()) {
    gainNode.disconnect()
  }
  gainNodes.clear()

  for (const [, track] of remoteTracks.entries()) {
    if (track) track._gainNode = null
  }
  remoteTracks.clear()

  if (closeAudioContext && sharedAudioContext) {
    sharedAudioContext.close().catch(() => {})
    sharedAudioContext = null
  }
}

// Aggregate RTP counters for each peer. Used by the browser reliability tests to
// distinguish "connected" from "media actually flowing in both directions".
export async function getPeerStats() {
  const result = []
  for (const [remoteId, pc] of peerConnections.entries()) {
    const entry = {
      remoteId,
      outboundAudioBytes: 0,
      outboundAudioPackets: 0,
      inboundAudioBytes: 0,
      inboundAudioPackets: 0,
    }
    try {
      const report = await pc.getStats()
      report.forEach(stat => {
        if (stat.type === 'outbound-rtp' && stat.kind === 'audio') {
          entry.outboundAudioBytes = stat.bytesSent || 0
          entry.outboundAudioPackets = stat.packetsSent || 0
        }
        if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
          entry.inboundAudioBytes = stat.bytesReceived || 0
          entry.inboundAudioPackets = stat.packetsReceived || 0
        }
      })
    } catch {
      entry.error = 'stats unavailable'
    }
    result.push(entry)
  }
  return result
}

export function getPeerCount() {
  return peerConnections.size
}

export function getConnectedPeers() {
  return Array.from(peerConnections.keys())
}

// Read-only diagnostics for tests and debugging. Exposes no media, no SDP, and
// no credentials — only connection state, track kinds and gain values.
//
// Field conventions:
//  - null gain usually means the track arrived but proximity has not been computed
//    yet (the graph node is created at gain 0), or the peer is not connected.
//  - When audioGraph is false but a remote audio track is present, the remote
//    track cannot be played (no AudioContext / no destination) rather than the
//    track being absent — see handleRemoteTrack.
export function getPeerDiagnostics() {
  return {
    localSocketId: getSocket()?.id || null,
    micActive: isMicActive(),
    // 'running' means the shared context is unlocked and can play audio;
    // 'suspended' after a reconnect otherwise goes unnoticed until nobody can
    // hear each other (see cleanupAllPeers).
    audioContextState: sharedAudioContext ? sharedAudioContext.state : null,
    peerCount: peerConnections.size,
    peers: Array.from(peerConnections.entries()).map(([remoteId, pc]) => {
      const gainNode = gainNodes.get(remoteId)
      const source = sources.get(remoteId)
      const audioGraph = Boolean(source && gainNode)
      return {
        remoteId,
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        signalingState: pc.signalingState,
        audioGraph,
        gain: gainNode ? gainNode.gain.value : null,
        // How many audio senders this connection actually has. More than one per
        // peer means a microphone cycle stacked senders instead of reusing one.
        localAudioSenders: typeof pc.getSenders === 'function'
          ? pc.getSenders().filter(sender => sender.track && sender.track.kind === 'audio').length
          : null,
        remoteAudioTracks: pc
          .getReceivers()
          .map(receiver => receiver.track)
          .filter(track => track && track.kind === 'audio')
          .map(track => ({ muted: Boolean(track.muted), readyState: track.readyState })),
        // Media-line directions, without exposing SDP. Used to diagnose one-way
        // audio (a recvonly answer is silent by construction).
        transceivers: typeof pc.getTransceivers === 'function'
          ? pc.getTransceivers().map(transceiver => ({
              mid: transceiver.mid,
              direction: transceiver.direction,
              currentDirection: transceiver.currentDirection,
              senderTrack: transceiver.sender?.track
                ? {
                    kind: transceiver.sender.track.kind,
                    readyState: transceiver.sender.track.readyState,
                    enabled: transceiver.sender.track.enabled,
                    muted: Boolean(transceiver.sender.track.muted),
                  }
                : null,
              receiverKind: transceiver.receiver?.track?.kind || null,
            }))
          : [],
        pendingCandidates: (pc._ppPendingCandidates || []).length,
        receivedRemoteTrack: pc
          .getReceivers()
          .some(receiver => receiver.track && receiver.track.kind === 'audio'),
        audioGraphAbsentWithRemoteTrack: !audioGraph
          && pc.getReceivers().some(receiver => receiver.track && receiver.track.kind === 'audio'),
      }
    }),
  }
}
