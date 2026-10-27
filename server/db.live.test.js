// Live MongoDB integration tests.
//
// These run against a REAL MongoDB instance and are skipped unless
// MONGODB_TEST_URI is set, so the default `npm test` stays hermetic.
//
// Run them with a local MongoDB (or Docker) listening:
//   docker run -d --name proxispeak-mongo-test -p 27018:27017 mongo:7
//   MONGODB_TEST_URI=mongodb://127.0.0.1:27018 npx vitest run db.live.test.js
//
// A throwaway database name is generated per run and dropped afterwards, so this
// never touches an application database.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  connect,
  disconnect,
  isConnected,
  getDb,
  createUser,
  createOffice,
  getUserByEmail,
  getOfficeBySlug,
  updateUserPosition,
  findUsersNearPosition,
  getOnlineUsersInOffice,
  positionToGeoJSON,
  geoJSONToPosition,
  VIRTUAL_COORDS,
} from './db.js'

const LIVE_URI = process.env.MONGODB_TEST_URI
const DB_NAME = `proxispeak_live_${Date.now()}`

const live = LIVE_URI ? describe : describe.skip

live('live MongoDB integration', () => {
  let office

  beforeAll(async () => {
    await connect(LIVE_URI, DB_NAME)
    office = await createOffice({ slug: 'design-team', name: 'Design Team', layout: { rooms: [] } })
  }, 30_000)

  afterAll(async () => {
    if (LIVE_URI) {
      const db = getDb()
      if (db) await db.dropDatabase()
      await disconnect()
    }
  }, 30_000)

  it('connects to a real server', () => {
    expect(isConnected()).toBe(true)
    expect(getDb().databaseName).toBe(DB_NAME)
  })

  it('creates the expected indexes, including the 2dsphere index', async () => {
    const userIndexes = await getDb().collection('users').indexes()
    const keys = userIndexes.map(i => i.key)
    expect(keys.some(k => k.email === 1)).toBe(true)
    expect(keys.some(k => k['location.geometry'] === '2dsphere')).toBe(true)
    expect(userIndexes.some(i => i.unique && i.key.email === 1)).toBe(true)

    const officeKeys = (await getDb().collection('offices').indexes()).map(i => i.key)
    expect(officeKeys.some(k => k.slug === 1)).toBe(true)

    const sessionKeys = (await getDb().collection('sessions').indexes()).map(i => i.key)
    expect(sessionKeys.some(k => k.userId === 1 && k.officeId === 1 && k.startedAt === -1)).toBe(true)
  })

  it('persists and retrieves users and offices, including across a reconnect', async () => {
    const user = await createUser({ email: 'alice@example.com', name: 'Alice', avatarColor: '#123456' })
    expect(user.id).toBeTruthy()

    expect((await getUserByEmail('alice@example.com')).name).toBe('Alice')
    expect((await getOfficeBySlug('design-team')).name).toBe('Design Team')

    // Drop the client connection and reconnect: the data must survive, i.e. it is
    // actually stored in MongoDB and not held in process memory.
    await disconnect()
    expect(isConnected()).toBe(false)
    await connect(LIVE_URI, DB_NAME)

    const reloaded = await getUserByEmail('alice@example.com')
    expect(reloaded).not.toBeNull()
    expect(reloaded.name).toBe('Alice')
    expect(reloaded.avatarColor).toBe('#123456')
  }, 30_000)

  it('enforces the unique email index', async () => {
    await expect(
      createUser({ email: 'alice@example.com', name: 'Impostor', avatarColor: '#000000' }),
    ).rejects.toThrow()
  })

  it('stores virtual coordinates, never real geographic lon/lat', async () => {
    const user = await getUserByEmail('alice@example.com')
    await updateUserPosition(user.id, office.id, 50, 50)

    const raw = await getDb().collection('users').findOne({ email: 'alice@example.com' })
    const { coordinates } = raw.location.geometry
    // 50%,50% maps to the middle of the VIRTUAL space: -180 + 180 = 0 and -90 + 90 = 0.
    expect(coordinates[0]).toBeCloseTo(VIRTUAL_COORDS.ORIGIN_LNG + VIRTUAL_COORDS.RANGE_LNG / 2, 6)
    expect(coordinates[1]).toBeCloseTo(VIRTUAL_COORDS.ORIGIN_LAT + VIRTUAL_COORDS.RANGE_LAT / 2, 6)
    expect(coordinates[0]).toBeGreaterThanOrEqual(-180)
    expect(coordinates[0]).toBeLessThanOrEqual(180)
    expect(coordinates[1]).toBeGreaterThanOrEqual(-90)
    expect(coordinates[1]).toBeLessThanOrEqual(90)

    // The public mapping stays in 0-100 percent space, not degrees.
    const pos = geoJSONToPosition(raw.location.geometry)
    expect(pos.x).toBeCloseTo(50, 5)
    expect(pos.y).toBeCloseTo(50, 5)
    expect(positionToGeoJSON(0, 0)).toEqual({
      type: 'Point',
      coordinates: [VIRTUAL_COORDS.ORIGIN_LNG, VIRTUAL_COORDS.ORIGIN_LAT],
    })
  })

  it('runs a real $geoWithin proximity query scoped to the office', async () => {
    const bob = await createUser({ email: 'bob@example.com', name: 'Bob', avatarColor: '#654321' })
    const carol = await createUser({ email: 'carol@example.com', name: 'Carol', avatarColor: '#abcdef' })
    const otherOffice = await createOffice({ slug: 'other-team', name: 'Other Team', layout: {} })
    const dave = await createUser({ email: 'dave@example.com', name: 'Dave', avatarColor: '#111111' })

    const alice = await getUserByEmail('alice@example.com')
    await updateUserPosition(alice.id, office.id, 50, 50)   // query origin
    await updateUserPosition(bob.id, office.id, 55, 50)     // within 10% radius
    await updateUserPosition(carol.id, office.id, 90, 90)   // far away
    await updateUserPosition(dave.id, otherOffice.id, 50, 50) // same spot, other office

    const near = await findUsersNearPosition(office.id, 50, 50, 10)
    const names = near.map(u => u.name).sort()
    expect(names).toContain('Alice')
    expect(names).toContain('Bob')
    expect(names).not.toContain('Carol')
    expect(names).not.toContain('Dave') // wrong office must never leak in

    const bobEntry = near.find(u => u.name === 'Bob')
    expect(bobEntry.position.x).toBeCloseTo(55, 5)
    expect(bobEntry.position.y).toBeCloseTo(50, 5)
    expect(bobEntry.distancePercent).toBeCloseTo(5, 5)

    const online = await getOnlineUsersInOffice(office.id)
    expect(online.map(u => u.name).sort()).toEqual(['Alice', 'Bob', 'Carol'])
    expect(online.every(u => u.position && Number.isFinite(u.position.x))).toBe(true)
  }, 30_000)
})
