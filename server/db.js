// MongoDB integration for ProxiSpeak persistent data.
//
// Stores:
// - User profiles (name, preferences, etc.)
// - Office definitions (room layouts, furniture)
// - Session history (who was in which room when)
//
// Does NOT store:
// - Real-time position updates (too frequent, handled by Socket.io)
// - Microphone audio (never stored)
//
// Coordinate system:
// - Virtual office uses percentage coordinates (0-100) for x/y
// - These are NOT geographic lat/lng
// - For MongoDB geospatial queries, we map to a virtual coordinate space
//   using a simple linear transform that preserves relative distances
// - We use a 2dsphere index on a virtual location field for proximity queries

import { MongoClient, ObjectId } from 'mongodb'

let client = null
let db = null

// Virtual coordinate mapping for geospatial queries.
// IMPORTANT: These virtual "longitude" and "latitude" values are an internal
// artifact for MongoDB 2dsphere index support and are NOT real geographic
// coordinates. The virtual-office position space (0-100 percentages) stays
// separate from any real-world lat/lng. Do not expose these virtual values to
// clients as geographic location.
const VIRTUAL_ORIGIN_LNG = -180  // Start of virtual "longitude"
const VIRTUAL_ORIGIN_LAT = -90   // Start of virtual "latitude"
const VIRTUAL_RANGE_LNG = 360   // Total range for x (0-100 -> 0-360)
const VIRTUAL_RANGE_LAT = 180   // Total range for y (0-100 -> 0-180)

function positionToGeoJSON(x, y) {
  // Map percentage coordinates to virtual geo coordinates
  const lng = VIRTUAL_ORIGIN_LNG + (x / 100) * VIRTUAL_RANGE_LNG
  const lat = VIRTUAL_ORIGIN_LAT + (y / 100) * VIRTUAL_RANGE_LAT
  return {
    type: 'Point',
    coordinates: [lng, lat],  // GeoJSON uses [lng, lat] order
  }
}

function geoJSONToPosition(geoJson) {
  if (!geoJson || geoJson.type !== 'Point') return null
  const [lng, lat] = geoJson.coordinates
  return {
    x: ((lng - VIRTUAL_ORIGIN_LNG) / VIRTUAL_RANGE_LNG) * 100,
    y: ((lat - VIRTUAL_ORIGIN_LAT) / VIRTUAL_RANGE_LAT) * 100,
  }
}

// Connection strings routinely embed credentials (`mongodb://user:pass@host`).
// They must never reach a log line, an error message, or a test artifact, so every
// log statement goes through this redaction.
export function redactMongoUri(uri) {
  if (typeof uri !== 'string') return '<unset>'
  return uri.replace(/\/\/[^/@]*@/, '//***@')
}

export async function connect(uri, dbName = 'proxispeak') {
  if (client) {
    await client.close()
    client = null
    db = null
  }

  client = new MongoClient(uri, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db(dbName)

  // Create indexes
  await db.collection('users').createIndexes([
    { key: { email: 1 }, unique: true },
    { key: { 'location.geometry': '2dsphere' } },  // For proximity queries
  ])

  await db.collection('offices').createIndexes([
    { key: { slug: 1 }, unique: true },
  ])

  await db.collection('sessions').createIndexes([
    { key: { userId: 1, officeId: 1, startedAt: -1 } },
    { key: { officeId: 1, endedAt: -1 } },
  ])

  console.log(`Connected to MongoDB: ${redactMongoUri(uri)}/${dbName}`)
  return db
}

// Liveness probe. `isConnected()` only reports that a client object exists; it
// stays true after the server goes away. Health checks and the recovery watchdog
// use this ping instead, with a bounded wait so a dead server cannot stall the
// HTTP handler.
export async function ping(timeoutMs = 1500) {
  if (!db) return false
  let timer
  try {
    await Promise.race([
      db.command({ ping: 1 }),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('ping timeout')), timeoutMs)
      }),
    ])
    return true
  } catch {
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function disconnect() {
  if (client) {
    await client.close()
    client = null
    db = null
    console.log('Disconnected from MongoDB')
  }
}

export function getDb() {
  return db
}

// Check if MongoDB is connected
export function isConnected() {
  return db !== null && client !== null
}

// User operations
export async function createUser({ email, name, avatarColor }) {
  if (!db) throw new Error('MongoDB not connected')

  const user = {
    email,
    name,
    avatarColor,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  const result = await db.collection('users').insertOne(user)
  return { id: result.insertedId.toString(), ...user }
}

export async function getUserById(id) {
  if (!db) throw new Error('MongoDB not connected')

  const objectId = new ObjectId(id)
  const user = await db.collection('users').findOne({ _id: objectId })
  if (!user) return null

  return { id: user._id.toString(), ...user, _id: undefined }
}

export async function getUserByEmail(email) {
  if (!db) throw new Error('MongoDB not connected')

  const user = await db.collection('users').findOne({ email })
  if (!user) return null

  return { id: user._id.toString(), ...user, _id: undefined }
}

// Office operations
export async function createOffice({ slug, name, layout }) {
  if (!db) throw new Error('MongoDB not connected')

  const office = {
    slug,
    name,
    layout,  // Stores room/furniture layout configuration
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  const result = await db.collection('offices').insertOne(office)
  return { id: result.insertedId.toString(), ...office }
}

export async function getOfficeBySlug(slug) {
  if (!db) throw new Error('MongoDB not connected')

  const office = await db.collection('offices').findOne({ slug })
  if (!office) return null

  return { id: office._id.toString(), ...office, _id: undefined }
}

// Session operations (track who was in which office and when)
export async function startSession(userId, officeId, roomId) {
  if (!db) throw new Error('MongoDB not connected')

  const session = {
    userId: new ObjectId(userId),
    officeId: new ObjectId(officeId),
    roomId,
    startedAt: new Date(),
    endedAt: null,
  }

  const result = await db.collection('sessions').insertOne(session)
  return { id: result.insertedId.toString(), ...session, _id: undefined }
}

export async function endSession(sessionId) {
  if (!db) throw new Error('MongoDB not connected')

  const objectId = new ObjectId(sessionId)
  await db.collection('sessions').updateOne(
    { _id: objectId },
    { $set: { endedAt: new Date() } }
  )
}

// Proximity queries using geospatial index
// Find users within a given radius (in virtual coordinate units)
export async function findUsersNearPosition(officeId, x, y, radiusPercent = 10) {
  if (!db) throw new Error('MongoDB not connected')

  const geoJson = positionToGeoJSON(x, y)

  // Convert percentage radius to virtual coordinate distance
  // 10% of 360 = 36 virtual units for longitude
  // 10% of 180 = 18 virtual units for latitude
  const maxDistanceLng = (radiusPercent / 100) * VIRTUAL_RANGE_LNG
  const maxDistanceLat = (radiusPercent / 100) * VIRTUAL_RANGE_LAT

  // Use $geoWithin with a box for proximity search
  // This finds users whose virtual location is within the specified box
  const box = {
    type: 'Polygon',
    coordinates: [[
      [geoJson.coordinates[0] - maxDistanceLng, geoJson.coordinates[1] - maxDistanceLat],
      [geoJson.coordinates[0] + maxDistanceLng, geoJson.coordinates[1] - maxDistanceLat],
      [geoJson.coordinates[0] + maxDistanceLng, geoJson.coordinates[1] + maxDistanceLat],
      [geoJson.coordinates[0] - maxDistanceLng, geoJson.coordinates[1] + maxDistanceLat],
      [geoJson.coordinates[0] - maxDistanceLng, geoJson.coordinates[1] - maxDistanceLat],  // Close the loop
    ]],
  }

  // The GeoJSON point lives at location.geometry (that is the field the 2dsphere
  // index is created on), so the $geoWithin operator must target that exact path.
  const users = await db.collection('users').find({
    officeId: new ObjectId(officeId),
    // GeoJSON shapes must be wrapped in $geometry; passing the Polygon directly
    // makes MongoDB reject the query with "unknown geo specifier".
    'location.geometry': {
      $geoWithin: { $geometry: box },
    },
  }).toArray()

  return users.map(u => ({
    id: u._id.toString(),
    name: u.name,
    avatarColor: u.avatarColor,
    position: geoJSONToPosition(u.location.geometry),
    distancePercent: calculateDistance(x, y, u.location.geometry.coordinates[0], u.location.geometry.coordinates[1]),
  }))
}

// Calculate distance between two positions in percentage units
function calculateDistance(x1, y1, lng2, lat2) {
  const pos2 = geoJSONToPosition({ type: 'Point', coordinates: [lng2, lat2] })
  return Math.sqrt(Math.pow(pos2.x - x1, 2) + Math.pow(pos2.y - y1, 2))
}

// Update user's current position (for presence tracking, not real-time)
export async function updateUserPosition(userId, officeId, x, y) {
  if (!db) throw new Error('MongoDB not connected')

  const objectId = new ObjectId(userId)
  const officeObjectId = new ObjectId(officeId)
  await db.collection('users').updateOne(
    { _id: objectId },
    {
      $set: {
        // Top-level officeId is what findUsersNearPosition / getOnlineUsersInOffice
        // filter on; location.officeId is kept for convenience on the document.
        officeId: officeObjectId,
        'location.geometry': positionToGeoJSON(x, y),
        'location.officeId': officeObjectId,
        'location.online': true,
        'location.updatedAt': new Date(),
        updatedAt: new Date(),
      },
    }
  )
}

// Get online users in an office (using a simple query, not geospatial)
export async function getOnlineUsersInOffice(officeId) {
  if (!db) throw new Error('MongoDB not connected')

  const users = await db.collection('users').find({
    officeId: new ObjectId(officeId),
    'location.online': true,
  }).toArray()

  return users.map(u => ({
    id: u._id.toString(),
    name: u.name,
    avatarColor: u.avatarColor,
    // A user document may exist without a location yet; do not crash the whole
    // query for that one document.
    position: u.location?.geometry ? geoJSONToPosition(u.location.geometry) : null,
  }))
}

// Error handling helper
export class DatabaseError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'DatabaseError'
    this.code = code
  }
}

// Safe database operation wrapper
export async function withDatabase(operation) {
  if (!db) {
    throw new DatabaseError('Database not connected', 'NOT_CONNECTED')
  }
  try {
    return await operation()
  } catch (error) {
    if (error instanceof DatabaseError) throw error
    throw new DatabaseError(error.message, error.code || 'UNKNOWN')
  }
}

// Export coordinate mapping functions for testing
// These are used to convert between percentage coordinates and virtual geo coordinates
export { positionToGeoJSON, geoJSONToPosition }
export const VIRTUAL_COORDS = {
  ORIGIN_LNG: VIRTUAL_ORIGIN_LNG,
  ORIGIN_LAT: VIRTUAL_ORIGIN_LAT,
  RANGE_LNG: VIRTUAL_RANGE_LNG,
  RANGE_LAT: VIRTUAL_RANGE_LAT,
}
