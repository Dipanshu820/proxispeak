// MongoDB outage and recovery, measured against a real server and a real MongoDB.
//
// Gated: this needs Docker and the `mongo:7` image, so it is skipped unless
// explicitly requested:
//
//   PROXISPEAK_MONGO_RECOVERY=1 npx vitest run mongo-recovery.test.js
//
// It proves three things the unit tests cannot:
//   1. the office keeps working (auth, presence, movement) with MongoDB down,
//   2. /api/health reports the outage instead of a stale "connected",
//   3. the watchdog reconnects on its own when MongoDB returns.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { io as ioc } from 'socket.io-client'

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ENTRY = path.join(SERVER_DIR, 'server.js')
const CONTAINER = 'proxispeak-recovery-test'
const MONGO_PORT = '27019'
const PORT = '4360'
const BASE_URL = `http://127.0.0.1:${PORT}`
const TEST_SECRET = 'mongo-recovery-test-secret-0123456789-abcdef'

const gated = process.env.PROXISPEAK_MONGO_RECOVERY === '1' ? describe : describe.skip

function docker(args) {
  return execFileSync('docker', args, { stdio: 'pipe', timeout: 60_000 }).toString()
}

function removeContainer() {
  try {
    docker(['rm', '-f', CONTAINER])
  } catch {
    // Not present; nothing to remove.
  }
}

async function waitFor(label, predicate, { timeout = 60_000, interval = 500 } = {}) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeout) {
    last = await predicate()
    if (last?.ok) return last
    await new Promise(resolve => setTimeout(resolve, interval))
  }
  throw new Error(`${label} did not happen within ${timeout}ms (last: ${JSON.stringify(last)})`)
}

async function health() {
  const res = await fetch(`${BASE_URL}/api/health`)
  return res.json()
}

async function startSession(roomId = 'design-team') {
  const res = await fetch(`${BASE_URL}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomId, name: 'Recovery Tester' }),
  })
  expect(res.status).toBe(200)
  return res.json()
}

function connectSocket(token) {
  return new Promise((resolve, reject) => {
    const client = ioc(BASE_URL, { reconnection: false, transports: ['websocket'], auth: { token } })
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 8000)
    client.once('connect', () => {
      clearTimeout(timer)
      resolve(client)
    })
    client.once('connect_error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function join(socket, roomId) {
  return new Promise(resolve => {
    socket.once('office:joined', resolve)
    socket.emit('office:join', { roomId })
  })
}

gated('MongoDB outage and recovery (Docker)', () => {
  let server

  beforeAll(async () => {
    removeContainer()
    server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        PORT,
        SESSION_SECRET: TEST_SECRET,
        CLIENT_ORIGIN: 'http://localhost:4173',
        MONGODB_URI: `mongodb://127.0.0.1:${MONGO_PORT}`,
        MONGODB_WATCHDOG_MS: '1000',
        // Signaling-layer test: use the explicit development anonymous-token
        // escape hatch instead of creating accounts in the recovery scenario.
        AUTH_ALLOW_ANONYMOUS: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await new Promise((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 20_000)
      server.stdout.on('data', chunk => {
        output += chunk.toString()
        if (output.includes('listening')) {
          clearTimeout(timer)
          resolve()
        }
      })
      server.stderr.on('data', chunk => { output += chunk.toString() })
    })
  }, 40_000)

  afterAll(() => {
    server?.kill()
    removeContainer()
  })

  it('keeps the office usable and reports the outage while MongoDB is down', async () => {
    const status = await health()
    expect(status.ok).toBe(false)
    expect(status.mongodb).toBe('error')

    // Authentication and presence do not depend on MongoDB.
    const session = await startSession()
    const socket = await connectSocket(session.token)
    try {
      await expect(join(socket, 'design-team')).resolves.toMatchObject({ roomId: 'design-team' })
      const ack = await new Promise(resolve => socket.emit('position:update', { x: 40, y: 40 }, resolve))
      expect(ack).toEqual({ ok: true })
    } finally {
      socket.disconnect()
    }
  }, 40_000)

  it('connects once MongoDB appears, reports a new outage, then recovers', async () => {
    docker(['run', '-d', '--name', CONTAINER, '-p', `${MONGO_PORT}:27017`, 'mongo:7'])

    await waitFor('initial MongoDB connection', async () => {
      const status = await health()
      return { ok: status.ok === true && status.mongodb === 'connected', status }
    }, { timeout: 90_000 })

    // Take the database away. The watchdog's ping (not a stale client handle)
    // must notice, and health must report the outage.
    docker(['stop', CONTAINER])
    await waitFor('detected outage', async () => {
      const status = await health()
      return { ok: status.ok === false && status.mongodb === 'error', status }
    }, { timeout: 30_000 })

    // Bring it back: the watchdog reconnects without a server restart.
    docker(['start', CONTAINER])
    await waitFor('recovered connection', async () => {
      const status = await health()
      return { ok: status.ok === true && status.mongodb === 'connected', status }
    }, { timeout: 90_000 })

    // The office still works after the outage.
    const session = await startSession()
    const socket = await connectSocket(session.token)
    try {
      await expect(join(socket, 'design-team')).resolves.toMatchObject({ roomId: 'design-team' })
    } finally {
      socket.disconnect()
    }
  }, 240_000)
})
