// Bounded, reproducible signaling-load test for ProxiSpeak.
//
// WHAT THIS MEASURES
//   - authentication/session issuance throughput,
//   - socket connect + office join latency,
//   - position:update round-trip latency (client -> server -> ack),
//   - room broadcast throughput (one emit fans out to every other client),
//   - WebRTC ICE relay delivery and end-to-end relay latency,
//   - error rate and the server's RSS/CPU before and after the run.
//
// WHAT THIS DOES NOT MEASURE
//   - browser WebRTC media. This script uses Socket.io clients only; there are no
//     RTCPeerConnections, no audio, and no video. Browser peer cost (O(n^2) mesh,
//     encode/decode) must be measured separately.
//
// The server must already be running. In development a session can be obtained
// anonymously; in production pass a join code with --join-code or PROXISPEAK_JOIN_CODE.
//
// Examples
//   node load-test.js --clients 20 --duration 10 --hz 5
//   node load-test.js --clients 50 --duration 15 --hz 2 --rooms 1
//   node load-test.js --clients 12 --duration 8 --signaling-pairs 4
//
// Every bound is clamped: clients <= 200, duration <= 120 s, hz <= 10. The script
// refuses to run unbounded so it cannot accidentally become a flood tool.

import { io } from 'socket.io-client'

const MAX_CLIENTS = 200
const MAX_DURATION_S = 120
const MAX_HZ = 10

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  return value === undefined ? fallback : value
}

const URL = String(arg('url', process.env.PROXISPEAK_URL || 'http://127.0.0.1:4000')).replace(/\/$/, '')
const CLIENTS = Math.max(1, Math.min(MAX_CLIENTS, Number(arg('clients', 20)) || 20))
const DURATION_S = Math.max(1, Math.min(MAX_DURATION_S, Number(arg('duration', 10)) || 10))
const HZ = Math.max(1, Math.min(MAX_HZ, Number(arg('hz', 5)) || 5))
const ROOMS = Math.max(1, Math.min(CLIENTS, Number(arg('rooms', 1)) || 1))
const SIGNALING_PAIRS = Math.max(0, Math.min(Math.floor(CLIENTS / 2), Number(arg('signaling-pairs', 4)) || 0))
const SIGNALING_PROBES = Math.max(1, Math.min(30, Number(arg('signaling-probes', 10)) || 10))
const ROOM_PREFIX = String(arg('room-prefix', 'load-test'))
const JOIN_CODE = arg('join-code', process.env.PROXISPEAK_JOIN_CODE || '')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Number(sorted[index].toFixed(2))
}

function summarize(values) {
  if (values.length === 0) return { count: 0, p50: null, p95: null, p99: null, max: null, mean: null }
  const sum = values.reduce((total, value) => total + value, 0)
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: Number(Math.max(...values).toFixed(2)),
    mean: Number((sum / values.length).toFixed(2)),
  }
}

function roomFor(index) {
  return `${ROOM_PREFIX}-${index % ROOMS}`
}

async function readHealth() {
  try {
    const res = await fetch(`${URL}/api/health`)
    return await res.json()
  } catch {
    return null
  }
}

async function issueSession(roomId, index) {
  const started = performance.now()
  const res = await fetch(`${URL}/api/auth/session`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(JOIN_CODE ? { 'x-proxispeak-join-code': JOIN_CODE } : {}),
    },
    body: JSON.stringify({ roomId, name: `Load ${index}` }),
  })
  const elapsed = performance.now() - started
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(`session ${res.status} ${body?.error?.code || ''}`.trim())
  }
  const body = await res.json()
  return { token: body.token, elapsed }
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const socket = io(URL, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token },
      timeout: 10_000,
    })
    const timer = setTimeout(() => {
      socket.disconnect()
      reject(new Error('connect timeout'))
    }, 12_000)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve({ socket, elapsed: performance.now() - started })
    })
    socket.once('connect_error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function main() {
  console.log(
    `ProxiSpeak signaling load test: url=${URL} clients=${CLIENTS} rooms=${ROOMS} ` +
      `duration=${DURATION_S}s hz=${HZ} signalingPairs=${SIGNALING_PAIRS}`,
  )
  console.log('Note: Socket.io only. This is server signaling load, not browser media load.')

  const healthBefore = await readHealth()
  if (!healthBefore) {
    console.error(`Server not reachable at ${URL}. Start it first (node server.js).`)
    process.exit(2)
  }

  const cpuStart = process.cpuUsage()
  const wallStart = Date.now()
  const errors = new Map()
  const recordError = message => errors.set(message, (errors.get(message) || 0) + 1)

  const sessionTimes = []
  const connectTimes = []
  const joinTimes = []
  const clients = []

  // ---------------------------------------------------------------- bootstrap
  for (let index = 0; index < CLIENTS; index += 1) {
    // Issued sequentially in small batches to stay far below the per-IP issuance
    // limiter (240/min) and to keep the latency samples meaningful.
    const roomId = roomFor(index)
    try {
      const session = await issueSession(roomId, index)
      sessionTimes.push(session.elapsed)
      const { socket, elapsed } = await connect(session.token)
      connectTimes.push(elapsed)
      const joinStarted = performance.now()
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('join timeout')), 10_000)
        socket.once('office:joined', () => {
          clearTimeout(timer)
          resolve()
        })
        socket.once('error', error => {
          clearTimeout(timer)
          reject(new Error(error?.code || 'join error'))
        })
        socket.emit('office:join', { roomId })
      })
      joinTimes.push(performance.now() - joinStarted)
      clients.push({ index, socket, roomId, received: 0, acked: 0, sent: 0, rtt: [] })
    } catch (error) {
      recordError(`bootstrap: ${error?.message || error}`)
    }
  }

  const readyClients = clients.length
  if (readyClients === 0) {
    console.error('No client could connect. Aborting.')
    process.exit(1)
  }

  for (const client of clients) {
    client.socket.on('position:update', () => {
      client.received += 1
    })
    client.socket.on('error', error => {
      recordError(`server: ${error?.code || 'unknown'}`)
    })
  }

  // ------------------------------------------------------------- position load
  console.log(`Load phase: ${DURATION_S}s at ${HZ} Hz per client...`)
  let sentTotal = 0
  const interval = setInterval(() => {
    for (const client of clients) {
      if (!client.socket.connected) continue
      const started = performance.now()
      sentTotal += 1
      client.sent += 1
      client.socket.emit(
        'position:update',
        { x: 20 + Math.random() * 60, y: 20 + Math.random() * 60 },
        ack => {
          if (ack?.ok) {
            client.acked += 1
            client.rtt.push(performance.now() - started)
          } else {
            recordError(`ack: ${ack?.code || 'unknown'}`)
          }
        },
      )
    }
  }, 1000 / HZ)

  await sleep(DURATION_S * 1000)
  clearInterval(interval)
  // Give late acks and fanout deliveries a moment to land.
  await sleep(1500)

  const rtt = clients.flatMap(client => client.rtt)
  const receivedTotal = clients.reduce((sum, client) => sum + client.received, 0)
  const ackedTotal = clients.reduce((sum, client) => sum + client.acked, 0)

  // ------------------------------------------------------------ signaling load
  let signaling = null
  if (SIGNALING_PAIRS > 0) {
    const pairPool = clients.filter(client => client.roomId === roomFor(0)).slice(0, SIGNALING_PAIRS * 2)
    const pairs = Math.floor(pairPool.length / 2)
    if (pairs > 0) {
      const deliveries = []
      const started = performance.now()
      const receivers = new Map()
      for (let pair = 0; pair < pairs; pair += 1) {
        const a = pairPool[pair * 2]
        const b = pairPool[pair * 2 + 1]
        receivers.set(b.socket.id, { client: b, partner: a, seen: new Set(), times: [] })
        receivers.set(a.socket.id, { client: a, partner: b, seen: new Set(), times: [] })
      }
      for (const [socketId, entry] of receivers) {
        entry.client.socket.on('webrtc:ice-candidate', payload => {
          const match = /^probe:(\d+):(\d+)$/.exec(String(payload?.candidate || ''))
          if (!match) return
          const key = `${payload.from}:${match[2]}`
          if (entry.seen.has(key)) return
          entry.seen.add(key)
          // Both timestamps are wall-clock Date.now(): performance.now() has a
          // different origin in the sender's event loop.
          entry.times.push(Date.now() - Number(match[1]))
          deliveries.push(1)
        })
      }

      for (let probe = 0; probe < SIGNALING_PROBES; probe += 1) {
        for (let pair = 0; pair < pairs; pair += 1) {
          const a = pairPool[pair * 2]
          const b = pairPool[pair * 2 + 1]
          a.socket.emit('webrtc:ice-candidate', {
            targetSocketId: b.socket.id,
            candidate: `probe:${Date.now()}:${probe}`,
            sdpMid: '0',
            sdpMLineIndex: 0,
          })
          b.socket.emit('webrtc:ice-candidate', {
            targetSocketId: a.socket.id,
            candidate: `probe:${Date.now()}:${probe}`,
            sdpMid: '0',
            sdpMLineIndex: 0,
          })
        }
        await sleep(20)
      }
      await sleep(1000)
      const relayTimes = [...receivers.values()].flatMap(entry => entry.times)
      signaling = {
        pairs,
        sent: pairs * 2 * SIGNALING_PROBES,
        delivered: deliveries.length,
        wallMs: Number((performance.now() - started).toFixed(1)),
        latencyMs: summarize(relayTimes),
      }
      for (const entry of receivers.values()) entry.client.socket.off('webrtc:ice-candidate')
    }
  }

  // ---------------------------------------------------------------- teardown
  await sleep(200)
  for (const client of clients) client.socket.disconnect()

  const healthAfter = await readHealth()
  const wallMs = Date.now() - wallStart
  const cpu = process.cpuUsage(cpuStart)
  const cpuTotalMs = (cpu.user + cpu.system) / 1000
  const generatorCpuPercent = Number(((cpuTotalMs / wallMs) * 100).toFixed(1))

  const serverCpuDeltaMicros = healthBefore?.cpu && healthAfter?.cpu
    ? (healthAfter.cpu.userMicros + healthAfter.cpu.systemMicros) -
      (healthBefore.cpu.userMicros + healthBefore.cpu.systemMicros)
    : null

  const errorCount = [...errors.values()].reduce((sum, count) => sum + count, 0)
  const perClientRate = (sentTotal / readyClients / (DURATION_S || 1)).toFixed(2)

  const result = {
    config: { url: URL, clients: CLIENTS, connected: readyClients, rooms: ROOMS, durationSeconds: DURATION_S, hz: HZ },
    authAndJoin: {
      sessionLatencyMs: summarize(sessionTimes),
      connectLatencyMs: summarize(connectTimes),
      joinLatencyMs: summarize(joinTimes),
    },
    positionLoad: {
      emitsSent: sentTotal,
      acks: ackedTotal,
      ackRatePercent: sentTotal ? Number(((ackedTotal / sentTotal) * 100).toFixed(1)) : 0,
      perClientHz: Number(perClientRate),
      broadcastDeliveries: receivedTotal,
      broadcastDeliveriesPerSecond: Number((receivedTotal / DURATION_S).toFixed(1)),
      rttMs: summarize(rtt),
    },
    signaling,
    errors: { total: errorCount, byType: Object.fromEntries(errors) },
    resources: {
      serverBefore: healthBefore
        ? { mongodb: healthBefore.mongodb, rssBytes: healthBefore.memory?.rssBytes ?? null, cpu: healthBefore.cpu ?? null }
        : null,
      serverAfter: healthAfter
        ? { mongodb: healthAfter.mongodb, rssBytes: healthAfter.memory?.rssBytes ?? null, cpu: healthAfter.cpu ?? null }
        : null,
      serverRssDeltaBytes:
        healthBefore?.memory?.rssBytes && healthAfter?.memory?.rssBytes
          ? healthAfter.memory.rssBytes - healthBefore.memory.rssBytes
          : null,
      loadGeneratorCpuPercentOfOneCore: generatorCpuPercent,
      serverCpuPercentOfOneCore:
        serverCpuDeltaMicros === null
          ? null
          : Number((((serverCpuDeltaMicros / 1000) / wallMs) * 100).toFixed(1)),
      wallMs,
    },
  }

  console.log('\n=== RESULTS ===')
  console.log(JSON.stringify(result, null, 2))

  const failureRate = sentTotal > 0 ? 1 - ackedTotal / sentTotal : 1
  if (errorCount > 0 && failureRate > 0.05) {
    console.error(`FAIL: ${errorCount} errors, ack rate ${((1 - failureRate) * 100).toFixed(1)}%`)
    process.exit(1)
  }
  if (signaling && signaling.delivered < signaling.sent) {
    console.error(`FAIL: signaling relay delivered ${signaling.delivered}/${signaling.sent}`)
    process.exit(1)
  }
  process.exit(0)
}

main().catch(error => {
  console.error('Load test crashed:', error?.message || error)
  process.exit(1)
})
