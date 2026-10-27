// Session-refresh behavior of the socket singleton.
//
// The server enforces token expiry for the lifetime of a connection (not only at
// the handshake), which means the client must be able to mint a fresh session and
// reconnect without a page reload. That path cannot be exercised in jsdom with a
// real server, so socket.io-client and the auth module are faked here; the real
// server side is covered by server/session-security.test.js.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('socket.io-client', () => ({
  io: (...args) => globalThis.__ioFactory(...args),
}))

vi.mock('../utils/auth.js', () => ({
  getSessionToken: () => globalThis.__token,
  requestSession: (...args) => globalThis.__requestSession(...args),
}))

const {
  connect,
  disconnect,
  joinRoom,
  getSocket,
} = await import('../utils/socket.js')

class FakeSocket {
  constructor() {
    this.id = 'socket-1'
    this.connected = false
    this.auth = {}
    this.emitted = []
    this.handlers = new Map()
    this.connectCalls = 0
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, [])
    this.handlers.get(event).push(handler)
  }

  off(event, handler) {
    const list = this.handlers.get(event) || []
    this.handlers.set(event, list.filter(fn => fn !== handler))
  }

  emit(event, payload) {
    this.emitted.push({ event, payload })
  }

  connect() {
    this.connectCalls += 1
    this.connected = true
    this.trigger('connect')
  }

  disconnect() {
    this.connected = false
    this.trigger('disconnect', 'io client disconnect')
  }

  trigger(event, payload) {
    for (const handler of [...(this.handlers.get(event) || [])]) handler(payload)
  }
}

const flush = async (times = 6) => {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

describe('socket session refresh', () => {
  let socket
  let requestSession

  beforeEach(() => {
    socket = new FakeSocket()
    globalThis.__ioFactory = () => socket
    globalThis.__token = 'initial-token'
    requestSession = vi.fn(async () => ({ token: 'refreshed-token' }))
    globalThis.__requestSession = requestSession
  })

  afterEach(() => {
    disconnect()
    delete globalThis.__ioFactory
    delete globalThis.__token
    delete globalThis.__requestSession
  })

  function connectedWithOnError(onError) {
    connect(() => {}, () => {}, onError)
    socket.connect()
    joinRoom('design-team', 'You')
    return socket
  }

  it('mints a fresh session and reconnects when the handshake reports expiry', async () => {
    const onError = vi.fn()
    connectedWithOnError(onError)
    const connectsBefore = socket.connectCalls

    socket.trigger('connect_error', { data: { code: 'AUTH_EXPIRED' } })
    await flush()

    expect(requestSession).toHaveBeenCalledTimes(1)
    expect(requestSession).toHaveBeenCalledWith({ roomId: 'design-team', name: 'You' })
    expect(socket.auth).toEqual({ token: 'refreshed-token' })
    expect(socket.connectCalls).toBe(connectsBefore + 1)
    // The recoverable path must not surface as an error to the UI.
    expect(onError).not.toHaveBeenCalled()
  })

  it('reconnects when the server expires the session of a live socket', async () => {
    const onError = vi.fn()
    connectedWithOnError(onError)

    const expired = []
    // The component-level listener is separate from the recovery itself.
    const unsubscribe = (await import('../utils/socket.js')).on('session:expired', data => {
      expired.push(data)
    })

    socket.trigger('session:expired', { code: 'AUTH_EXPIRED' })
    await flush()

    expect(expired).toEqual([{ code: 'AUTH_EXPIRED' }])
    expect(requestSession).toHaveBeenCalledTimes(1)
    // A live connection is closed first: the server may not have dropped it yet,
    // and connect() on a connected socket would be a no-op.
    expect(socket.auth).toEqual({ token: 'refreshed-token' })
    expect(socket.connected).toBe(true)
    expect(socket.connectCalls).toBe(2)
    unsubscribe()
  })

  it('does not loop on a non-recoverable handshake error', async () => {
    const onError = vi.fn()
    connectedWithOnError(onError)

    socket.trigger('connect_error', { data: { code: 'AUTH_INVALID_SIGNATURE' } })
    await flush()

    expect(requestSession).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].data.code).toBe('AUTH_INVALID_SIGNATURE')
  })

  it('surfaces the original error when the refresh itself fails', async () => {
    const onError = vi.fn()
    connectedWithOnError(onError)
    requestSession.mockRejectedValueOnce(new Error('backend unavailable'))

    socket.trigger('connect_error', { data: { code: 'AUTH_EXPIRED' } })
    await flush()

    expect(requestSession).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].data.code).toBe('AUTH_EXPIRED')
    expect(getSocket()).toBe(socket)
  })

  it('only refreshes once for a burst of expiry events', async () => {
    connectedWithOnError(vi.fn())
    let resolveSession
    requestSession.mockImplementation(
      () => new Promise(resolve => { resolveSession = resolve }),
    )

    socket.trigger('session:expired', { code: 'AUTH_EXPIRED' })
    socket.trigger('session:expired', { code: 'AUTH_EXPIRED' })
    await flush(2)

    expect(requestSession).toHaveBeenCalledTimes(1)
    resolveSession({ token: 'refreshed-token' })
    await flush()
    expect(socket.auth).toEqual({ token: 'refreshed-token' })
  })
})
