// Focused tests for the client WebRTC lifecycle: peer creation, perfect
// negotiation (glare), ICE buffering, and every cleanup path. RTCPeerConnection
// is a fake so this runs in jsdom; these tests prove the signalling decisions and
// bookkeeping, NOT that real media flows (that needs browsers — see
// tests/browser/webrtc-peer.spec.js).
//
// Import order matters: socket.js must be mocked before webrtc.js is evaluated,
// because webrtc.js captures getSocket from it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../utils/socket.js', () => ({
  getSocket: () => globalThis.__fakeSocket,
}))

const {
  init,
  destroy,
  requestMic,
  releaseMic,
  initiatePeerConnection,
  cleanupPeerConnection,
  cleanupAllPeers,
  updateProximityVolume,
  getPeerCount,
  getConnectedPeers,
  getPeerDiagnostics,
} = await import('../utils/webrtc.js')

class FakePeerConnection {
  static instances = []

  constructor(config) {
    this.config = config
    this.localDescription = null
    this.remoteDescription = null
    this.signalingState = 'stable'
    this.connectionState = 'new'
    this.iceConnectionState = 'new'
    this.closed = false
    this.addedCandidates = []
    this.senders = []
    this.onicecandidate = null
    this.ontrack = null
    this.onconnectionstatechange = null
    this.onnegotiationneeded = null
    FakePeerConnection.instances.push(this)
  }

  createOffer() {
    return Promise.resolve({ type: 'offer', sdp: 'fake-offer' })
  }

  createAnswer() {
    return Promise.resolve({ type: 'answer', sdp: 'fake-answer' })
  }

  setLocalDescription(description) {
    if (description.type === 'rollback') {
      this.localDescription = null
      this.signalingState = 'stable'
      return Promise.resolve()
    }
    this.localDescription = description
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable'
    return Promise.resolve()
  }

  setRemoteDescription(description) {
    this.remoteDescription = description
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable'
    return Promise.resolve()
  }

  addIceCandidate(candidate) {
    if (!this.remoteDescription) {
      return Promise.reject(new Error('The remote description was null'))
    }
    this.addedCandidates.push(candidate)
    return Promise.resolve()
  }

  getReceivers() {
    return []
  }

  addTrack(track) {
    const sender = {
      track,
      replaceTrack(next) {
        this.track = next
        return Promise.resolve()
      },
    }
    this.senders.push(sender)
  }

  getSenders() {
    return this.senders
  }

  close() {
    this.closed = true
    this.signalingState = 'closed'
    this.connectionState = 'closed'
  }
}

class FakeAudioNode {
  constructor(context) {
    this.context = context
    this.disconnected = false
  }

  connect() {}

  disconnect() {
    this.disconnected = true
  }
}

class FakeGainNode extends FakeAudioNode {
  constructor(context) {
    super(context)
    this.gain = {
      value: 0,
      setValueAtTime(value) { this.value = value },
      setTargetAtTime(value) { this.value = value },
    }
  }
}

class FakeAudioContext {
  static instances = []

  constructor() {
    this.state = 'running'
    this.currentTime = 0
    this.destination = new FakeAudioNode(this)
    FakeAudioContext.instances.push(this)
  }

  createGain() {
    return new FakeGainNode(this)
  }

  createMediaStreamSource() {
    return new FakeAudioNode(this)
  }

  resume() {
    this.state = 'running'
    return Promise.resolve()
  }

  close() {
    this.state = 'closed'
    return Promise.resolve()
  }
}

function fakeAudioTrack() {
  const handlers = new Map()
  return {
    kind: 'audio',
    readyState: 'live',
    enabled: true,
    muted: false,
    _gainNode: undefined,
    addEventListener(event, handler) {
      handlers.set(event, handler)
    },
    emitEnded() {
      const handler = handlers.get('ended')
      if (handler) handler()
    },
    stop() {},
  }
}

function makeFakeSocket(id = 'local-socket') {
  return {
    id,
    connected: true,
    emitted: [],
    listeners: new Map(),
    emit(event, payload) {
      this.emitted.push({ event, payload })
    },
    on(event, handler) {
      if (!this.listeners.has(event)) this.listeners.set(event, [])
      this.listeners.get(event).push(handler)
    },
    off(event, handler) {
      const list = this.listeners.get(event)
      if (!list) return
      this.listeners.set(event, list.filter(fn => fn !== handler))
    },
    trigger(event, payload) {
      for (const handler of this.listeners.get(event) || []) handler(payload)
    },
    listenerCount(event) {
      return (this.listeners.get(event) || []).length
    },
  }
}

const flush = async (times = 4) => {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

describe('client WebRTC peer lifecycle', () => {
  beforeEach(() => {
    FakePeerConnection.instances = []
    globalThis.RTCPeerConnection = FakePeerConnection
    globalThis.RTCSessionDescription = class {
      constructor(init) { Object.assign(this, init) }
    }
    globalThis.RTCIceCandidate = class {
      constructor(init) { Object.assign(this, init) }
    }
    globalThis.__fakeSocket = makeFakeSocket()
    FakeAudioContext.instances = []
    globalThis.MediaStream = class {
      constructor(tracks = []) { this.tracks = tracks }
      getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio') }
    }
    window.AudioContext = FakeAudioContext
  })

  afterEach(() => {
    // destroy() first: the module tracks whether it already attached listeners,
    // and each test gets a fresh fake socket object, so the flag has to be reset.
    destroy()
    cleanupAllPeers()
    delete globalThis.__fakeSocket
    delete globalThis.RTCPeerConnection
    delete globalThis.RTCSessionDescription
    delete globalThis.RTCIceCandidate
    delete globalThis.MediaStream
    delete window.AudioContext
  })

  it('creates one peer connection per remote user and emits an offer', async () => {
    initiatePeerConnection('remote-1', 'remote-1', 'Maya')
    await flush()

    expect(getPeerCount()).toBe(1)
    expect(getConnectedPeers()).toEqual(['remote-1'])

    const offer = globalThis.__fakeSocket.emitted.find(e => e.event === 'webrtc:offer')
    expect(offer).toBeTruthy()
    expect(offer.payload.targetSocketId).toBe('remote-1')
    expect(offer.payload.sdp).toEqual({ type: 'offer', sdp: 'fake-offer' })
  })

  it('does not duplicate a peer connection for the same remote user', () => {
    initiatePeerConnection('remote-1')
    initiatePeerConnection('remote-1')
    expect(getPeerCount()).toBe(1)
  })

  it('does not create anything when the socket is disconnected', () => {
    globalThis.__fakeSocket.connected = false
    initiatePeerConnection('remote-1')
    expect(getPeerCount()).toBe(0)
  })

  it('cleanupPeerConnection closes the connection and forgets it', async () => {
    initiatePeerConnection('remote-1')
    await flush()
    const [pc] = FakePeerConnection.instances

    cleanupPeerConnection('remote-1')

    expect(pc.closed).toBe(true)
    expect(getPeerCount()).toBe(0)
    expect(getConnectedPeers()).toEqual([])
  })

  it('cleanupAllPeers closes every connection', async () => {
    initiatePeerConnection('remote-1')
    initiatePeerConnection('remote-2')
    await flush()
    expect(getPeerCount()).toBe(2)

    cleanupAllPeers()

    expect(FakePeerConnection.instances.every(pc => pc.closed)).toBe(true)
    expect(getPeerCount()).toBe(0)
  })

  it('removes the peer when the server reports the socket disconnecting', async () => {
    init()
    initiatePeerConnection('remote-1')
    await flush()

    globalThis.__fakeSocket.trigger('webrtc:peer-disconnected', { from: 'remote-1' })

    expect(getPeerCount()).toBe(0)
    expect(FakePeerConnection.instances[0].closed).toBe(true)
  })

  it('removes the peer when presence:left arrives for it', async () => {
    init()
    initiatePeerConnection('remote-1')
    await flush()

    globalThis.__fakeSocket.trigger('presence:left', { userId: 'remote-1' })

    expect(getPeerCount()).toBe(0)
    expect(FakePeerConnection.instances[0].closed).toBe(true)
  })

  it('ignores presence:left for a peer it does not know', async () => {
    init()
    initiatePeerConnection('remote-1')
    await flush()
    globalThis.__fakeSocket.trigger('presence:left', { userId: 'someone-else' })
    expect(getPeerCount()).toBe(1)
  })

  it('destroy removes the socket listeners and closes every peer', async () => {
    init()
    expect(globalThis.__fakeSocket.listenerCount('webrtc:invite')).toBe(1)
    expect(globalThis.__fakeSocket.listenerCount('presence:left')).toBe(1)

    initiatePeerConnection('remote-1')
    await flush()
    destroy()

    expect(globalThis.__fakeSocket.listenerCount('webrtc:invite')).toBe(0)
    expect(globalThis.__fakeSocket.listenerCount('webrtc:peer-disconnected')).toBe(0)
    expect(globalThis.__fakeSocket.listenerCount('presence:left')).toBe(0)
    expect(getPeerCount()).toBe(0)
  })

  it('is idempotent: init() twice does not duplicate listeners', () => {
    init()
    init()
    expect(globalThis.__fakeSocket.listenerCount('webrtc:invite')).toBe(1)
    expect(globalThis.__fakeSocket.listenerCount('presence:left')).toBe(1)
  })

  it('buffers ICE candidates that arrive before the remote description', async () => {
    init()
    initiatePeerConnection('remote-1')
    await flush()
    const [pc] = FakePeerConnection.instances
    // Local offer, no remote description yet.
    expect(pc.remoteDescription).toBeNull()

    globalThis.__fakeSocket.trigger('webrtc:ice-candidate', {
      from: 'remote-1',
      candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    })

    expect(getPeerDiagnostics().peers[0].pendingCandidates).toBe(1)
    expect(pc.addedCandidates).toHaveLength(0)

    globalThis.__fakeSocket.trigger('webrtc:accepted', {
      from: 'remote-1',
      sdp: { type: 'answer', sdp: 'fake-answer' },
    })
    await flush()

    expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: 'fake-answer' })
    expect(pc.addedCandidates).toHaveLength(1)
    expect(getPeerDiagnostics().peers[0].pendingCandidates).toBe(0)
  })

  it('drops ICE candidates that arrive after cleanup', async () => {
    init()
    initiatePeerConnection('remote-1')
    await flush()
    const [pc] = FakePeerConnection.instances
    cleanupPeerConnection('remote-1')

    globalThis.__fakeSocket.trigger('webrtc:ice-candidate', {
      from: 'remote-1',
      candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host',
    })
    await flush()

    expect(getPeerCount()).toBe(0)
    expect(pc.addedCandidates).toHaveLength(0)
  })

  it('the polite peer rolls back its own offer and answers a colliding one', async () => {
    // local id sorts before the remote id => polite
    globalThis.__fakeSocket = makeFakeSocket('aaaa')
    init()
    initiatePeerConnection('zzzz')
    await flush()
    const [pc] = FakePeerConnection.instances
    expect(pc.signalingState).toBe('have-local-offer')

    globalThis.__fakeSocket.trigger('webrtc:invite', {
      from: 'zzzz',
      sdp: { type: 'offer', sdp: 'their-offer' },
      userName: 'Zed',
    })
    await flush()

    // Rolled back, accepted their offer, produced and sent an answer.
    expect(pc.remoteDescription).toEqual({ type: 'offer', sdp: 'their-offer' })
    expect(pc.localDescription).toEqual({ type: 'answer', sdp: 'fake-answer' })
    const accept = globalThis.__fakeSocket.emitted.find(e => e.event === 'webrtc:accept')
    expect(accept).toBeTruthy()
    expect(accept.payload.fromSocketId).toBe('zzzz')
    expect(accept.payload.sdp).toEqual({ type: 'answer', sdp: 'fake-answer' })
  })

  it('the impolite peer ignores a colliding offer and keeps its own', async () => {
    // local id sorts after the remote id => impolite
    globalThis.__fakeSocket = makeFakeSocket('zzzz')
    init()
    initiatePeerConnection('aaaa')
    await flush()
    const [pc] = FakePeerConnection.instances
    expect(pc.signalingState).toBe('have-local-offer')

    globalThis.__fakeSocket.trigger('webrtc:invite', {
      from: 'aaaa',
      sdp: { type: 'offer', sdp: 'their-offer' },
      userName: 'Ay',
    })
    await flush()

    // Ignored: no remote description applied, no answer emitted.
    expect(pc.remoteDescription).toBeNull()
    expect(pc.signalingState).toBe('have-local-offer')
    expect(globalThis.__fakeSocket.emitted.some(e => e.event === 'webrtc:accept')).toBe(false)
  })

  it('ignores a late answer when no local offer is pending', async () => {
    init()
    initiatePeerConnection('remote-1')
    await flush()
    const [pc] = FakePeerConnection.instances
    // Simulate the exchange having already completed.
    pc.signalingState = 'stable'

    globalThis.__fakeSocket.trigger('webrtc:accepted', {
      from: 'remote-1',
      sdp: { type: 'answer', sdp: 'late' },
    })
    await flush()

    expect(pc.closed).toBe(false)
    expect(pc.remoteDescription).toBeNull()
  })

  it('does not apply a gain update after the peer was cleaned up', async () => {
    initiatePeerConnection('remote-1')
    await flush()
    cleanupPeerConnection('remote-1')

    // Must be a no-op: no throw, no resurrected connection, no audio node.
    expect(() => updateProximityVolume('remote-1', 0, 0, 10, 10)).not.toThrow()
    expect(getPeerCount()).toBe(0)
    expect(getPeerDiagnostics().peers).toEqual([])
  })

  it('keeps exactly one live audio sender across mic enable/disable cycles', async () => {
    const makeTrack = () => ({
      kind: 'audio',
      enabled: true,
      readyState: 'live',
      stop() { this.readyState = 'ended' },
    })
    const makeStream = () => {
      const tracks = [makeTrack()]
      return {
        getAudioTracks: () => tracks,
        getTracks: () => tracks,
      }
    }

    navigator.mediaDevices = navigator.mediaDevices || {}
    navigator.mediaDevices.getUserMedia = async () => makeStream()

    initiatePeerConnection('remote-1')
    await flush()
    const [pc] = FakePeerConnection.instances

    await requestMic()
    await flush()
    expect(pc.senders.filter(s => s.track?.kind === 'audio')).toHaveLength(1)

    // Disable and re-enable: the stopped sender must be reused, not stacked.
    releaseMic()
    await requestMic()
    await flush()
    const audioSenders = pc.senders.filter(s => s.track?.kind === 'audio')
    expect(audioSenders).toHaveLength(1)
    expect(audioSenders[0].track.readyState).toBe('live')
  })

  it('cleans up one peer without touching the other', async () => {
    initiatePeerConnection('remote-1')
    initiatePeerConnection('remote-2')
    await flush()
    expect(getPeerCount()).toBe(2)

    cleanupPeerConnection('remote-1')

    expect(getConnectedPeers()).toEqual(['remote-2'])
    expect(FakePeerConnection.instances[0].closed).toBe(true)
    expect(FakePeerConnection.instances[1].closed).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Audio graph lifecycle (Web Audio is faked; MediaStream is faked)
  // -------------------------------------------------------------------------

  it('disconnects the stale audio graph when a closed connection is replaced', async () => {
    initiatePeerConnection('remote-1')
    await flush()
    const [first] = FakePeerConnection.instances

    const track = fakeAudioTrack()
    first.ontrack({ track })
    expect(getPeerDiagnostics().peers[0].audioGraph).toBe(true)

    // A connection can be closed by the browser (ICE failure) while the peer map
    // still holds it. Re-initiating must not leave the dead graph playing.
    first.close()
    initiatePeerConnection('remote-1')
    await flush()

    const diagnostics = getPeerDiagnostics()
    expect(diagnostics.peerCount).toBe(1)
    expect(diagnostics.peers[0].audioGraph).toBe(false)
    expect(track._gainNode).toBeNull()
  })

  it('detaches the audio graph when a remote track ends but keeps the connection', async () => {
    initiatePeerConnection('remote-1')
    await flush()
    const [pc] = FakePeerConnection.instances

    const track = fakeAudioTrack()
    pc.ontrack({ track })
    expect(getPeerDiagnostics().peers[0].audioGraph).toBe(true)

    track.readyState = 'ended'
    track.emitEnded()

    const diagnostics = getPeerDiagnostics()
    // The audio nodes are gone, but the peer connection itself survives so a
    // replacement track can reuse it.
    expect(diagnostics.peerCount).toBe(1)
    expect(diagnostics.peers[0].audioGraph).toBe(false)
    expect(track._gainNode).toBeNull()
  })

  it('keeps the unlocked AudioContext across a cleanup and closes it on destroy', async () => {
    navigator.mediaDevices = navigator.mediaDevices || {}
    navigator.mediaDevices.getUserMedia = async () => ({
      getAudioTracks: () => [{ kind: 'audio', enabled: true, readyState: 'live', stop() {} }],
      getTracks: () => [],
    })

    await requestMic()
    expect(getPeerDiagnostics().audioContextState).toBe('running')

    // A transient reconnect drops peers but must not close the context; a closed
    // context cannot be resumed without another user gesture.
    cleanupAllPeers()
    expect(getPeerDiagnostics().audioContextState).toBe('running')

    destroy()
    expect(FakeAudioContext.instances.at(-1).state).toBe('closed')
    expect(getPeerDiagnostics().audioContextState).toBeNull()
  })

  // The operational runbook tells operators to distinguish an ICE failure from
  // an audio-graph failure using these fields. That guidance is only trustworthy
  // if the flags actually separate the two cases.
  it('distinguishes an audio-graph failure from an ICE failure', async () => {
    initiatePeerConnection('remote-1')
    await flush()
    const [pc] = FakePeerConnection.instances

    // Media arrived from the remote peer, but nothing can play it.
    pc.getReceivers = () => [
      { track: { kind: 'audio', muted: false, readyState: 'live' } },
    ]

    const mediaWithoutGraph = getPeerDiagnostics().peers[0]
    expect(mediaWithoutGraph.receivedRemoteTrack).toBe(true)
    expect(mediaWithoutGraph.audioGraph).toBe(false)
    expect(mediaWithoutGraph.audioGraphAbsentWithRemoteTrack).toBe(true)
    expect(mediaWithoutGraph.iceConnectionState).toBe('new')

    // A transport failure is reported separately, so 'ICE failed' and 'graph
    // missing' cannot be confused with each other.
    pc.iceConnectionState = 'failed'
    pc.connectionState = 'failed'
    const iceFailure = getPeerDiagnostics().peers[0]
    expect(iceFailure.iceConnectionState).toBe('failed')
    expect(iceFailure.connectionState).toBe('failed')

    // Building the graph clears the audio-graph flag.
    pc.ontrack({ track: fakeAudioTrack() })
    const working = getPeerDiagnostics().peers[0]
    expect(working.audioGraph).toBe(true)
    expect(working.audioGraphAbsentWithRemoteTrack).toBe(false)
  })

  it('reports per-peer diagnostics', async () => {
    initiatePeerConnection('remote-1')
    await flush()

    const diagnostics = getPeerDiagnostics()
    expect(diagnostics.localSocketId).toBe('local-socket')
    expect(diagnostics.peerCount).toBe(1)
    expect(diagnostics.peers[0]).toMatchObject({
      remoteId: 'remote-1',
      signalingState: 'have-local-offer',
      audioGraph: false,
      gain: null,
    })
  })
})
