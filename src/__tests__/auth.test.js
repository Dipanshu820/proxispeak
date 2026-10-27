import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  AuthError,
  clearSession,
  fetchIceServers,
  getSessionToken,
  requestSession,
  setSessionToken,
} from '../utils/auth.js'

const TOKEN = 'v1.eyJ2IjoxfQ.signature'

function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  }
}

beforeEach(() => {
  clearSession()
})

describe('requestSession', () => {
  it('posts the room with the account cookie and keeps the token in memory only', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, token: TOKEN, expiresAt: 123, roomId: 'design-team', name: 'Alice' }),
    )

    const session = await requestSession({ roomId: 'design-team', name: 'Alice', fetchImpl })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/auth/session')
    expect(options.method).toBe('POST')
    // The HttpOnly account cookie must ride along: issuance requires a real
    // signed-in account. Page JavaScript still never sees that cookie.
    expect(options.credentials).toBe('include')
    expect(JSON.parse(options.body)).toEqual({ roomId: 'design-team', name: 'Alice' })
    expect(options.headers['x-proxispeak-join-code']).toBeUndefined()

    expect(session.token).toBe(TOKEN)
    expect(getSessionToken()).toBe(TOKEN)
    // Never persisted: XSS cannot lift the session out of localStorage.
    expect(window.localStorage.length).toBe(0)
  })

  it('sends the join code header only when one is configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, token: TOKEN }))
    await requestSession({ roomId: 'ops', joinCode: 'join-code-123', fetchImpl })
    expect(fetchImpl.mock.calls[0][1].headers['x-proxispeak-join-code']).toBe('join-code-123')
  })

  it('surfaces the server rejection code and stores no token', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, error: { code: 'ROOM_FORBIDDEN' } }, 403))

    await expect(requestSession({ roomId: 'secret', fetchImpl })).rejects.toMatchObject({
      code: 'ROOM_FORBIDDEN',
      status: 403,
    })
    expect(getSessionToken()).toBeNull()
  })

  it('maps an unavailable or unreachable backend to AUTH_UNAVAILABLE', async () => {
    await expect(requestSession({ roomId: 'design-team', fetchImpl: undefined })).rejects.toMatchObject({
      code: 'AUTH_UNAVAILABLE',
    })

    const failing = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(requestSession({ roomId: 'design-team', fetchImpl: failing })).rejects.toMatchObject({
      code: 'AUTH_UNAVAILABLE',
    })
    expect(getSessionToken()).toBeNull()
  })

  it('maps a timeout to AUTH_TIMEOUT', async () => {
    const aborting = vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    await expect(requestSession({ roomId: 'design-team', fetchImpl: aborting })).rejects.toMatchObject({
      code: 'AUTH_TIMEOUT',
    })
  })

  it('rejects a successful response that does not contain a token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    await expect(requestSession({ roomId: 'design-team', fetchImpl })).rejects.toBeInstanceOf(AuthError)
    expect(getSessionToken()).toBeNull()
  })

  it('rejects non-JSON responses without leaking body content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('not json')
      },
    })
    await expect(requestSession({ roomId: 'design-team', fetchImpl })).rejects.toMatchObject({
      code: 'HTTP_502',
    })
  })
})

describe('fetchIceServers', () => {
  it('sends the bearer token and returns the ICE list', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        iceServers: [{ urls: 'stun:stun.example.com' }, { urls: 'turn:t.example.com', username: 'u', credential: 'c' }],
        turnEnabled: true,
      }),
    )

    const result = await fetchIceServers({ token: TOKEN, fetchImpl })

    expect(fetchImpl.mock.calls[0][0]).toBe('/api/ice')
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(result.turnEnabled).toBe(true)
    expect(result.iceServers).toHaveLength(2)
  })

  it('returns null for an unauthorized or failed request', async () => {
    const unauthorized = vi.fn().mockResolvedValue(jsonResponse({ ok: false }, 401))
    expect(await fetchIceServers({ token: TOKEN, fetchImpl: unauthorized })).toBeNull()

    const failing = vi.fn().mockRejectedValue(new TypeError('offline'))
    expect(await fetchIceServers({ token: TOKEN, fetchImpl: failing })).toBeNull()
  })

  it('does not call the backend without a token', async () => {
    const fetchImpl = vi.fn()
    expect(await fetchIceServers({ token: null, fetchImpl })).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('session memory', () => {
  it('setSessionToken stores and clears without persisting', () => {
    setSessionToken(TOKEN, { roomId: 'design-team' })
    expect(getSessionToken()).toBe(TOKEN)
    setSessionToken(null)
    expect(getSessionToken()).toBeNull()
    expect(window.localStorage.length).toBe(0)
  })
})
