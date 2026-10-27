// Account persistence.
//
// Two interchangeable, genuinely persistent implementations:
//
//   * MongoDB (used whenever MONGODB_URI is configured) — a `users` collection
//     with a unique index on the normalized email. Production path.
//   * A JSON file (used when MONGODB_URI is absent) — for local development and
//     for the account test suite. It is a real on-disk store with atomic
//     writes, not an in-memory fake, and it is single-instance only.
//
// The server never silently splits accounts between the two: if MONGODB_URI is
// set, only the Mongo store is used, and a temporarily unavailable database
// surfaces as a 503 instead of quietly writing accounts somewhere else.
//
// No plaintext password ever reaches this module: callers pass a password hash.

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export class DuplicateEmailError extends Error {
  constructor() {
    super('An account with this email already exists')
    this.name = 'DuplicateEmailError'
    this.code = 'EMAIL_TAKEN'
  }
}

export class UserStoreUnavailableError extends Error {
  constructor(cause) {
    super('Account store is unavailable')
    this.name = 'UserStoreUnavailableError'
    this.code = 'ACCOUNT_STORE_UNAVAILABLE'
    this.cause = cause
  }
}

function publicUser(doc) {
  if (!doc) return null
  return {
    id: String(doc._id ?? doc.id),
    email: doc.email,
    name: doc.name,
    avatarColor: doc.avatarColor || '#45e0c0',
    preferences: {
      theme: doc.preferences?.theme === 'light' ? 'light' : 'dark',
      defaultRoom: typeof doc.preferences?.defaultRoom === 'string' ? doc.preferences.defaultRoom : 'design-team',
      mutedByDefault: Boolean(doc.preferences?.mutedByDefault),
    },
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt,
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : doc.updatedAt,
  }
}

// `credential` is the stored hash; it is returned to the login handler only and
// is never part of `publicUser`, so it cannot leak through /api/auth/me.
function internalUser(doc) {
  if (!doc) return null
  return {
    ...publicUser(doc),
    passwordHash: doc.passwordHash,
  }
}

export function createFileUserStore({ filePath, now = () => new Date() } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('createFileUserStore requires filePath')
  }

  let cache = null
  let loadPromise = null
  // Serializes read-modify-write cycles and file writes. Two concurrent signups
  // for the same email must not both pass the uniqueness check.
  let queue = Promise.resolve()

  function enqueue(task) {
    const run = queue.then(task, task)
    // Keep the chain alive even if a task rejects.
    queue = run.catch(() => {})
    return run
  }

  async function readFile() {
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || !Array.isArray(parsed.users)) return []
      return parsed.users
    } catch (error) {
      if (error.code === 'ENOENT') return []
      if (error instanceof SyntaxError) {
        throw new UserStoreUnavailableError(new Error(`Account store at ${filePath} is not valid JSON`))
      }
      throw new UserStoreUnavailableError(error)
    }
  }

  async function writeFile(users) {
    const directory = path.dirname(filePath)
    await fs.mkdir(directory, { recursive: true })
    const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    const payload = JSON.stringify({ version: 1, users }, null, 2)
    await fs.writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 })
    // Atomic replace: a crash mid-write leaves the previous file intact.
    await fs.rename(temporary, filePath)
  }

  async function load() {
    if (cache) return cache
    if (!loadPromise) {
      loadPromise = readFile()
        .then((users) => {
          cache = users
          return cache
        })
        .finally(() => {
          loadPromise = null
        })
    }
    return loadPromise
  }

  return {
    kind: 'file',
    describe() {
      return `local file (${filePath}) — single-instance development store`
    },
    async init() {
      await load()
    },
    async close() {
      cache = null
    },
    async createUser({ email, name, passwordHash, avatarColor }) {
      return enqueue(async () => {
        const users = await load()
        if (users.some((user) => user.email === email)) throw new DuplicateEmailError()

        const timestamp = now().toISOString()
        const user = {
          id: crypto.randomUUID(),
          email,
          name,
          passwordHash,
          avatarColor: avatarColor || '#45e0c0',
          preferences: { theme: 'dark', defaultRoom: 'design-team', mutedByDefault: false },
          createdAt: timestamp,
          updatedAt: timestamp,
          lastLoginAt: null,
        }
        users.push(user)
        try {
          await writeFile(users)
        } catch (error) {
          // Roll the in-memory copy back so it matches what is on disk.
          users.pop()
          throw new UserStoreUnavailableError(error)
        }
        return publicUser(user)
      })
    },
    async findByEmail(email) {
      const users = await load()
      return internalUser(users.find((user) => user.email === email) || null)
    },
    async findById(id) {
      const users = await load()
      return internalUser(users.find((user) => user.id === id) || null)
    },
    async updateUser(id, changes) {
      return enqueue(async () => {
        const users = await load()
        const user = users.find((candidate) => candidate.id === id)
        if (!user) return null

        if (typeof changes.name === 'string') user.name = changes.name
        if (changes.preferences && typeof changes.preferences === 'object') {
          user.preferences = {
            ...user.preferences,
            ...changes.preferences,
          }
        }
        user.updatedAt = now().toISOString()
        try {
          await writeFile(users)
        } catch (error) {
          throw new UserStoreUnavailableError(error)
        }
        return publicUser(user)
      })
    },
    async recordLogin(id) {
      return enqueue(async () => {
        const users = await load()
        const user = users.find((candidate) => candidate.id === id)
        if (!user) return
        user.lastLoginAt = now().toISOString()
        try {
          await writeFile(users)
        } catch {
          // A failed "last login" stamp must not fail the login itself.
        }
      })
    },
    async count() {
      return (await load()).length
    },
  }
}

export function createMongoUserStore({ getDb, isConnected, now = () => new Date() } = {}) {
  if (typeof getDb !== 'function') throw new Error('createMongoUserStore requires getDb')

  let indexesReady = false

  function collection() {
    if (typeof isConnected === 'function' && !isConnected()) {
      throw new UserStoreUnavailableError(new Error('MongoDB is not connected'))
    }
    const db = getDb()
    if (!db) throw new UserStoreUnavailableError(new Error('MongoDB is not connected'))
    return db.collection('users')
  }

  async function ensureIndexes() {
    if (indexesReady) return
    const users = collection()
    // Existing deployments already have this index; createIndexes is idempotent.
    await users.createIndexes([{ key: { email: 1 }, unique: true }])
    indexesReady = true
  }

  return {
    kind: 'mongodb',
    describe() {
      return 'MongoDB users collection'
    },
    async init() {
      await ensureIndexes()
    },
    async close() {},
    async createUser({ email, name, passwordHash, avatarColor }) {
      try {
        await ensureIndexes()
        const timestamp = now()
        const _id = crypto.randomUUID()
        const doc = {
          _id,
          email,
          name,
          passwordHash,
          avatarColor: avatarColor || '#45e0c0',
          preferences: { theme: 'dark', defaultRoom: 'design-team', mutedByDefault: false },
          createdAt: timestamp,
          updatedAt: timestamp,
          lastLoginAt: null,
        }
        await collection().insertOne(doc)
        return publicUser(doc)
      } catch (error) {
        if (error instanceof UserStoreUnavailableError) throw error
        if (error?.code === 11000) throw new DuplicateEmailError()
        throw new UserStoreUnavailableError(error)
      }
    },
    async findByEmail(email) {
      try {
        const doc = await collection().findOne({ email })
        return internalUser(doc)
      } catch (error) {
        if (error instanceof UserStoreUnavailableError) throw error
        throw new UserStoreUnavailableError(error)
      }
    },
    async findById(id) {
      try {
        const doc = await collection().findOne({ _id: id })
        return internalUser(doc)
      } catch (error) {
        if (error instanceof UserStoreUnavailableError) throw error
        throw new UserStoreUnavailableError(error)
      }
    },
    async updateUser(id, changes) {
      try {
        const update = { updatedAt: now() }
        if (typeof changes.name === 'string') update.name = changes.name
        if (changes.preferences && typeof changes.preferences === 'object') {
          for (const [key, value] of Object.entries(changes.preferences)) {
            update[`preferences.${key}`] = value
          }
        }
        const result = await collection().findOneAndUpdate(
          { _id: id },
          { $set: update },
          { returnDocument: 'after' },
        )
        return publicUser(result?.value ?? result)
      } catch (error) {
        if (error instanceof UserStoreUnavailableError) throw error
        throw new UserStoreUnavailableError(error)
      }
    },
    async recordLogin(id) {
      try {
        await collection().updateOne({ _id: id }, { $set: { lastLoginAt: now() } })
      } catch {
        // Best effort; never fail a login because the stamp failed.
      }
    },
    async count() {
      return collection().countDocuments()
    },
  }
}

export { publicUser }
