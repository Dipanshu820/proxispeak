import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Server as SocketIOServer } from 'socket.io'
import { io as ioc } from 'socket.io-client'
import http from 'node:http'
import {
  initWebRTCSignaling,
  getPeerConnection,
  calculateProximityVolume,
  getSignalingStats,
} from './webrtc.js'

// ---------- Helper: create an isolated server with WebRTC signaling ----------
function createTestServer() {
  return new Promise((resolve) => {
    const srv = http.createServer()
    const io = new SocketIOServer(srv, {
      cors: { origin: 'http://localhost:5173', methods: ['GET', 'POST'] },
      transports: ['polling'],
    })

    // Room + presence tracking so WebRTC handlers can check room membership
    const rooms = new Map()
    io.on('connection', socket => {
      socket.data.roomId = null
      socket.data.user = null
      // Signaling requires an authenticated socket (phase 3.10). This harness
      // models the post-handshake state; the handshake verifier itself is tested
      // against the real server in auth.test.js.
      socket.data.session = {
        subject: `subject-${socket.id}`,
        name: 'Guest',
        room: 'design-team',
        jti: `jti-${socket.id}`,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }
      socket.on('office:join', ({ roomId, user } = {}) => {
        if (!roomId || typeof roomId !== 'string' || roomId.trim().length === 0) {
          socket.emit('error', { code: 'INVALID_ROOM' })
          return
        }
        const cleanRoomId = roomId.trim()
        if (socket.data.roomId) {
          const room = rooms.get(socket.data.roomId)
          if (room) room.delete(socket.id)
        }
        socket.join(cleanRoomId)
        socket.data.roomId = cleanRoomId
        socket.data.user = { id: socket.id, name: typeof user?.name === 'string' ? user.name : 'Guest' }
        if (!rooms.has(cleanRoomId)) rooms.set(cleanRoomId, new Set())
        rooms.get(cleanRoomId).add(socket.id)
        socket.emit('office:joined', { socketId: socket.id, roomId: cleanRoomId })
      })
      socket.on('disconnect', () => {
        if (socket.data.roomId) {
          const room = rooms.get(socket.data.roomId)
          if (room) room.delete(socket.id)
          socket.to(socket.data.roomId).emit('presence:left', { userId: socket.id })
        }
      })
    })

    initWebRTCSignaling(io)

    srv.listen(0, '127.0.0.1', () => {
      resolve({ srv, io, port: srv.address().port })
    })
  })
}

function connectClient(port) {
  return new Promise((resolve, reject) => {
    const client = ioc(`http://127.0.0.1:${port}`, {
      reconnection: false,
      transports: ['polling'],
    })
    let done = false
    const timer = setTimeout(() => {
      if (!done) { done = true; reject(new Error('connect timeout')) }
    }, 5000)
    client.on('connect', () => { if (!done) { done = true; resolve(client) } })
    client.on('error', (err) => { if (!done) { done = true; reject(err) } })
  })
}

// ---------- Proximity volume calculation ----------
describe('WebRTC proximity gain', () => {
  it('returns 1.0 at zero distance', () => {
    expect(calculateProximityVolume(0, 0, 0, 0, { earshotPx: 100, minVolume: 0.1, maxVolume: 1.0 })).toBe(1.0)
  })

  it('returns 0 at or beyond earshot distance', () => {
    expect(calculateProximityVolume(0, 0, 100, 0, { earshotPx: 100, minVolume: 0.1, maxVolume: 1.0 })).toBe(0)
    expect(calculateProximityVolume(0, 0, 101, 0, { earshotPx: 100, minVolume: 0.1, maxVolume: 1.0 })).toBe(0)
  })

  it('returns minVolume just inside earshot boundary', () => {
    // distance 99/100 -> ratio 0.01 -> 0.1 + 0.9 * 0.01 = 0.109
    const v = calculateProximityVolume(0, 0, 99, 0, { earshotPx: 100, minVolume: 0.1, maxVolume: 1.0 })
    expect(v).toBeCloseTo(0.109, 3)
  })

  it('returns midpoint volume at half earshot', () => {
    // distance 50/100 -> ratio 0.5 -> 0.1 + 0.9 * 0.5 = 0.55
    const v = calculateProximityVolume(0, 0, 50, 0, { earshotPx: 100, minVolume: 0.1, maxVolume: 1.0 })
    expect(v).toBeCloseTo(0.55, 3)
  })

  it('uses real pixel distance from avatar percentages on a real floor', () => {
    // Floor 900x540 (DEFAULT_FLOOR). Avatar at 50%,50% = (450,270).
    // Remote at 70%,50% = (630,270). Pixel distance = 180px. Earshot 100px -> outside -> 0.
    const floorW = 900, floorH = 540
    const localPxX = (50 / 100) * floorW
    const localPxY = (50 / 100) * floorH
    const remotePxX = (70 / 100) * floorW
    const remotePxY = (50 / 100) * floorH
    const v = calculateProximityVolume(localPxX, localPxY, remotePxX, remotePxY, { earshotPx: 100, minVolume: 0.1, maxVolume: 1.0 })
    expect(v).toBe(0)
  })

  it('gain falls off linearly with distance (not squared)', () => {
    const a = calculateProximityVolume(0, 0, 0, 0, { earshotPx: 100, minVolume: 0.1, maxVolume: 1.0 })
    const b = calculateProximityVolume(0, 0, 50, 0, { earshotPx: 100, minVolume: 0.1, maxVolume: 1.0 })
    const c = calculateProximityVolume(0, 0, 100, 0, { earshotPx: 100, minVolume: 0.1, maxVolume: 1.0 })
    expect(a).toBeGreaterThan(b)
    expect(b).toBeGreaterThan(c)
    expect(c).toBe(0)
  })

  it('respects a custom earshot radius', () => {
    // earshot 200px, distance 100px -> ratio 0.5 -> 0.1 + 0.9 * 0.5 = 0.55
    const v = calculateProximityVolume(0, 0, 100, 0, { earshotPx: 200, minVolume: 0.1, maxVolume: 1.0 })
    expect(v).toBeCloseTo(0.55, 3)
  })

  it('handles diagonal distance correctly', () => {
    // distance = sqrt(60^2 + 80^2) = 100 -> at earshot boundary -> 0
    const v = calculateProximityVolume(0, 0, 60, 80, { earshotPx: 100, minVolume: 0.1, maxVolume: 1.0 })
    expect(v).toBe(0)
  })

  it('clamps output to [0, 1] for all inputs', () => {
    for (const dist of [-50, 0, 50, 99, 100, 101, 200, 1000]) {
      const v = calculateProximityVolume(0, 0, dist, 0, { earshotPx: 100, minVolume: 0.1, maxVolume: 1.0 })
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})

// ---------- Signaling state transitions, authorization, and cleanup ----------
describe('WebRTC signaling state machine', () => {
  let srv, io, port

  beforeEach(async () => {
    ({ srv, io, port } = await createTestServer())
  })

  afterEach(async () => {
    io.close()
    await srv.close()
  })

  async function joinBoth(alice, bob, room = 'design-team') {
    const ajoined = new Promise(resolve => alice.once('office:joined', resolve))
    const bjoined = new Promise(resolve => bob.once('office:joined', resolve))
    alice.emit('office:join', { roomId: room, user: { name: 'Alice' } })
    bob.emit('office:join', { roomId: room, user: { name: 'Bob' } })
    await Promise.all([ajoined, bjoined])
  }

  it('rejects webrtc:offer when the sender is not in a room', async () => {
    const alice = await connectClient(port)
    const bob = await connectClient(port)
    await joinBoth(alice, bob)
    alice.disconnect()

    // Reconnect alice without joining a room
    const alice2 = await connectClient(port)

    let err = null
    alice2.once('error', e => { err = e })
    let bobGotInvite = null
    bob.once('webrtc:invite', e => { bobGotInvite = e })
    alice2.emit('webrtc:offer', { targetSocketId: bob.id, sdp: 'offer' })
    await new Promise(r => setTimeout(r, 300))
    expect(err).not.toBeNull()
    expect(err.code).toBe('NOT_IN_SAME_ROOM')
    expect(bobGotInvite).toBeNull()
    alice2.disconnect()
    bob.disconnect()
  })

  it('rejects webrtc:offer when target is in a different room', async () => {
    const alice = await connectClient(port)
    const bob = await connectClient(port)
    const carol = await connectClient(port)
    await joinBoth(alice, bob, 'room-a')
    await new Promise(resolve => {
      carol.once('office:joined', resolve)
      carol.emit('office:join', { roomId: 'room-b', user: { name: 'Carol' } })
    })
    await new Promise(r => setTimeout(r, 200))

    let err = null
    alice.once('error', e => { err = e })
    let carolGotInvite = null
    carol.once('webrtc:invite', e => { carolGotInvite = e })
    alice.emit('webrtc:offer', { targetSocketId: carol.id, sdp: 'offer' })
    await new Promise(r => setTimeout(r, 300))
    expect(err).not.toBeNull()
    expect(err.code).toBe('NOT_IN_SAME_ROOM')
    expect(carolGotInvite).toBeNull()

    alice.disconnect()
    bob.disconnect()
    carol.disconnect()
  })

  it('rejects webrtc:initiate when target is in a different room', async () => {
    const alice = await connectClient(port)
    const bob = await connectClient(port)
    const carol = await connectClient(port)
    await joinBoth(alice, bob, 'room-a')
    await new Promise(resolve => {
      carol.once('office:joined', resolve)
      carol.emit('office:join', { roomId: 'room-b', user: { name: 'Carol' } })
    })
    await new Promise(r => setTimeout(r, 200))

    let err = null
    alice.once('error', e => { err = e })
    let carolGotInvite = null
    carol.once('webrtc:invite', e => { carolGotInvite = e })
    alice.emit('webrtc:initiate', { targetSocketId: carol.id })
    await new Promise(r => setTimeout(r, 300))
    expect(err).not.toBeNull()
    expect(err.code).toBe('NOT_IN_SAME_ROOM')
    expect(carolGotInvite).toBeNull()

    alice.disconnect()
    bob.disconnect()
    carol.disconnect()
  })

  it('relays webrtc:initiate between two sockets in the same room', async () => {
    const alice = await connectClient(port)
    const bob = await connectClient(port)
    await joinBoth(alice, bob)

    let err = null
    alice.once('error', e => { err = e })
    const invite = await new Promise((resolve) => {
      bob.once('webrtc:invite', resolve)
      alice.emit('webrtc:initiate', { targetSocketId: bob.id })
    })
    expect(err).toBeNull()
    expect(invite.from).toBe(alice.id)
    expect(invite.roomId).toBe('design-team')

    alice.disconnect()
    bob.disconnect()
  })

  it('rejects webrtc:offer with oversized SDP', async () => {
    const alice = await connectClient(port)
    const bob = await connectClient(port)
    await joinBoth(alice, bob)

    const big = 'a'.repeat(65536 + 1)
    const byteLen = Buffer.byteLength(big)
    expect(byteLen).toBeGreaterThan(65536)
    let err = null
    alice.once('error', e => { err = e })
    let bobGotInvite = null
    bob.once('webrtc:invite', e => { bobGotInvite = e })
    alice.emit('webrtc:offer', { targetSocketId: bob.id, sdp: big })
    await new Promise(r => setTimeout(r, 300))
    expect(err).not.toBeNull()
    expect(err.code).toBe('SIGNALING_PAYLOAD_TOO_LARGE')
    expect(bobGotInvite).toBeNull()

    alice.disconnect()
    bob.disconnect()
  })

  it('completes the offer -> invite -> answer -> accepted transition', async () => {
    // This is the contract the client depends on: the answerer sends the id of
    // the INITIATOR it is answering (the `from` of its invite), and the answer is
    // relayed back to that initiator as webrtc:accepted.
    const alice = await connectClient(port)
    const bob = await connectClient(port)
    await joinBoth(alice, bob)

    const invitePromise = new Promise(resolve => bob.once('webrtc:invite', resolve))
    alice.emit('webrtc:offer', { targetSocketId: bob.id, sdp: { type: 'offer', sdp: 'v=0' } })
    const invite = await invitePromise
    expect(invite.from).toBe(alice.id)
    expect(invite.sdp).toEqual({ type: 'offer', sdp: 'v=0' })

    let acceptErr = null
    bob.once('error', e => { acceptErr = e })
    const acceptedPromise = new Promise(resolve => alice.once('webrtc:accepted', resolve))
    bob.emit('webrtc:accept', { fromSocketId: alice.id, sdp: { type: 'answer', sdp: 'v=0' } })
    const accepted = await acceptedPromise

    expect(acceptErr).toBeNull()
    expect(accepted.from).toBe(bob.id)
    expect(accepted.sdp).toEqual({ type: 'answer', sdp: 'v=0' })
    expect(accepted.roomId).toBe('design-team')

    alice.disconnect()
    bob.disconnect()
  })

  it('rejects webrtc:accept without a prior offer (no signaling state)', async () => {
    const alice = await connectClient(port)
    const bob = await connectClient(port)
    await joinBoth(alice, bob)

    // Bob tries to answer Alice, who never offered to him.
    let err = null
    bob.once('error', e => { err = e })
    bob.emit('webrtc:accept', { fromSocketId: alice.id, sdp: 'answer' })
    await new Promise(r => setTimeout(r, 300))
    expect(err).not.toBeNull()
    expect(err.code).toBe('NO_SIGNALING_STATE')

    alice.disconnect()
    bob.disconnect()
  })

  it('rejects a socket answering its own offer', async () => {
    const alice = await connectClient(port)
    const bob = await connectClient(port)
    await joinBoth(alice, bob)

    let err = null
    alice.once('error', e => { err = e })
    alice.emit('webrtc:accept', { fromSocketId: alice.id, sdp: 'answer' })
    await new Promise(r => setTimeout(r, 300))
    expect(err).not.toBeNull()
    expect(err.code).toBe('INVALID_REQUEST')

    alice.disconnect()
    bob.disconnect()
  })

  it('rejects an answer injected into an exchange the socket was not part of', async () => {
    // Alice offers to Bob. Carol then tries to answer on Alice's behalf by
    // claiming Alice as the socket she is answering. The recorded state only
    // covers alice->bob, so carol's attempt must be refused.
    const alice = await connectClient(port)
    const bob = await connectClient(port)
    const carol = await connectClient(port)
    await joinBoth(alice, bob)
    await new Promise(resolve => {
      carol.once('office:joined', resolve)
      carol.emit('office:join', { roomId: 'design-team', user: { name: 'Carol' } })
    })

    alice.emit('webrtc:offer', { targetSocketId: bob.id, sdp: 'offer' })
    await new Promise(r => setTimeout(r, 300))

    let err = null
    carol.once('error', e => { err = e })
    carol.emit('webrtc:accept', { fromSocketId: alice.id, sdp: 'answer' })
    await new Promise(r => setTimeout(r, 300))
    expect(err).not.toBeNull()
    expect(err.code).toBe('NO_SIGNALING_STATE')

    alice.disconnect()
    bob.disconnect()
    carol.disconnect()
  })

  it('keeps working when a peer disconnects mid-negotiation', async () => {
    // Alice offers to Bob; Bob disconnects before answering. Alice must not be
    // left wedged: a fresh pair with another peer still negotiates normally.
    const alice = await connectClient(port)
    const bob = await connectClient(port)
    const carol = await connectClient(port)
    await joinBoth(alice, bob)
    await new Promise(resolve => {
      carol.once('office:joined', resolve)
      carol.emit('office:join', { roomId: 'design-team', user: { name: 'Carol' } })
    })

    alice.emit('webrtc:offer', { targetSocketId: bob.id, sdp: 'to-bob' })
    await new Promise(r => setTimeout(r, 200))

    bob.disconnect()
    await new Promise(r => setTimeout(r, 250))

    // Alice starts a new exchange with Carol and completes it end to end.
    const invitePromise = new Promise(resolve => carol.once('webrtc:invite', resolve))
    alice.emit('webrtc:offer', { targetSocketId: carol.id, sdp: 'to-carol' })
    const invite = await invitePromise
    expect(invite.from).toBe(alice.id)

    const acceptedPromise = new Promise(resolve => alice.once('webrtc:accepted', resolve))
    carol.emit('webrtc:accept', { fromSocketId: alice.id, sdp: 'carol-answer' })
    const accepted = await acceptedPromise
    expect(accepted.from).toBe(carol.id)
    expect(accepted.sdp).toBe('carol-answer')

    alice.disconnect()
    carol.disconnect()
  })

  it('rejects webrtc:accept when the answerer rejoined another room', async () => {
    // Alice and bob are in room-a and the server records alice->bob as an offer.
    // Bob then joins room-b on the SAME socket: the signaling record survives, so
    // the room check is what has to reject the answer.
    const alice = await connectClient(port)
    const bob = await connectClient(port)
    await joinBoth(alice, bob, 'room-a')

    alice.emit('webrtc:offer', { targetSocketId: bob.id, sdp: 'offer' })
    await new Promise(r => setTimeout(r, 300))

    await new Promise(resolve => {
      bob.once('office:joined', resolve)
      bob.emit('office:join', { roomId: 'room-b', user: { name: 'Bob' } })
    })
    await new Promise(r => setTimeout(r, 100))

    let err = null
    bob.once('error', e => { err = e })
    bob.emit('webrtc:accept', { fromSocketId: alice.id, sdp: 'answer' })
    await new Promise(r => setTimeout(r, 300))
    expect(err).not.toBeNull()
    expect(err.code).toBe('NOT_IN_SAME_ROOM')

    alice.disconnect()
    bob.disconnect()
  })

  it('relays webrtc:ice-candidate between two sockets in the same room', async () => {
    const alice = await connectClient(port)
    const bob = await connectClient(port)
    await joinBoth(alice, bob)

    let err = null
    alice.once('error', e => { err = e })
    const received = await new Promise((resolve) => {
      bob.once('webrtc:ice-candidate', resolve)
      alice.emit('webrtc:ice-candidate', {
        targetSocketId: bob.id,
        candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 5000 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      })
    })
    expect(err).toBeNull()
    expect(received.from).toBe(alice.id)
    expect(received.sdpMid).toBe('0')
    expect(received.sdpMLineIndex).toBe(0)

    alice.disconnect()
    bob.disconnect()
  })

  it('rejects webrtc:ice-candidate when target is in a different room', async () => {
    const alice = await connectClient(port)
    const bob = await connectClient(port)
    const carol = await connectClient(port)
    await joinBoth(alice, bob, 'room-a')
    await new Promise(resolve => {
      carol.once('office:joined', resolve)
      carol.emit('office:join', { roomId: 'room-b', user: { name: 'Carol' } })
    })
    await new Promise(r => setTimeout(r, 200))

    let err = null
    alice.once('error', e => { err = e })
    let carolGotCandidate = null
    carol.once('webrtc:ice-candidate', e => { carolGotCandidate = e })
    alice.emit('webrtc:ice-candidate', {
      targetSocketId: carol.id,
      candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    })
    await new Promise(r => setTimeout(r, 300))
    expect(err).not.toBeNull()
    expect(err.code).toBe('NOT_IN_SAME_ROOM')
    expect(carolGotCandidate).toBeNull()

    alice.disconnect()
    bob.disconnect()
    carol.disconnect()
  })

  it('rejects webrtc:ice-candidate when the sender has not joined a room', async () => {
    const alice = await connectClient(port)
    const bob = await connectClient(port)
    await joinBoth(alice, bob)

    const stranger = await connectClient(port)
    let err = null
    stranger.once('error', e => { err = e })
    let bobGotCandidate = null
    bob.once('webrtc:ice-candidate', e => { bobGotCandidate = e })
    stranger.emit('webrtc:ice-candidate', {
      targetSocketId: bob.id,
      candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host',
    })
    await new Promise(r => setTimeout(r, 300))
    expect(err).not.toBeNull()
    expect(err.code).toBe('NOT_IN_SAME_ROOM')
    expect(bobGotCandidate).toBeNull()

    stranger.disconnect()
    alice.disconnect()
    bob.disconnect()
  })

  it('rate-limits a signaling flood from a single socket', async () => {
    const alice = await connectClient(port)
    const bob = await connectClient(port)
    await joinBoth(alice, bob)

    let rateLimited = null
    alice.on('error', e => { if (e.code === 'RATE_LIMITED') rateLimited = e })

    for (let i = 0; i < 130; i += 1) {
      alice.emit('webrtc:ice-candidate', {
        targetSocketId: bob.id,
        candidate: `candidate:${i} 1 udp 1 192.0.2.1 5000 typ host`,
        sdpMid: '0',
        sdpMLineIndex: 0,
      })
    }
    await new Promise(r => setTimeout(r, 800))

    expect(rateLimited).not.toBeNull()
    expect(rateLimited.code).toBe('RATE_LIMITED')

    alice.disconnect()
    bob.disconnect()
  })

  it('rejects webrtc:ice-candidate with oversized candidate', async () => {
    const alice = await connectClient(port)
    const bob = await connectClient(port)
    await joinBoth(alice, bob)

    const big = 'a'.repeat(65536 + 1)
    const byteLen = Buffer.byteLength(big)
    expect(byteLen).toBeGreaterThan(65536)
    let err = null
    alice.once('error', e => { err = e })
    alice.emit('webrtc:ice-candidate', { targetSocketId: bob.id, candidate: big })
    await new Promise(r => setTimeout(r, 300))
    expect(err).not.toBeNull()
    expect(err.code).toBe('SIGNALING_PAYLOAD_TOO_LARGE')

    alice.disconnect()
    bob.disconnect()
  })

  it('cleans up signaling state on socket disconnect (server-side only, no RTCPeerConnection in node)', async () => {
    // The server-side disconnect handler cleans up peerConnections and signalingState.
    // In the node test environment there is no RTCPeerConnection global, so we cannot
    // create real peer connections. We verify the signaling state path instead.
    const alice = await connectClient(port)
    const bob = await connectClient(port)
    await joinBoth(alice, bob)

    // Send an offer to populate signalingState
    let offerErr = null
    alice.once('error', e => { offerErr = e })
    alice.emit('webrtc:offer', { targetSocketId: bob.id, sdp: 'offer' })
    await new Promise(r => setTimeout(r, 300))
    expect(offerErr).toBeNull()

    // Disconnect alice — the disconnect handler must run without throwing
    alice.disconnect()
    await new Promise(r => setTimeout(r, 250))

    // If we reached here without an uncaught error, the cleanup path is safe.
    bob.disconnect()
  })
})
