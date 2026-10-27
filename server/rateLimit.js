// Small fixed-window rate limiter used by the authentication endpoints.
//
// In-memory and per-process, which is adequate for a single instance and is
// documented as such. The map is pruned on a timer and bounded, so an attacker
// cycling keys cannot grow it without limit.

export function createRateLimiter({
  windowMs = 60_000,
  max = 10,
  maxEntries = 20_000,
  now = () => Date.now(),
} = {}) {
  const entries = new Map() // key -> { count, resetAt }

  function prune(at = now()) {
    for (const [key, entry] of entries) {
      if (entry.resetAt <= at) entries.delete(key)
    }
    if (entries.size > maxEntries) {
      // Drop the oldest inserted entries; Map preserves insertion order.
      const excess = entries.size - maxEntries
      let removed = 0
      for (const key of entries.keys()) {
        entries.delete(key)
        if (++removed >= excess) break
      }
    }
  }

  return {
    check(key) {
      const at = now()
      if (entries.size > maxEntries) prune(at)
      const entry = entries.get(key)
      if (!entry || entry.resetAt <= at) {
        entries.set(key, { count: 1, resetAt: at + windowMs })
        return { allowed: true, remaining: Math.max(0, max - 1), retryAfterMs: windowMs }
      }
      if (entry.count >= max) {
        return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, entry.resetAt - at) }
      }
      entry.count += 1
      return { allowed: true, remaining: Math.max(0, max - entry.count), retryAfterMs: Math.max(0, entry.resetAt - at) }
    },
    reset(key) {
      entries.delete(key)
    },
    prune,
    get size() {
      return entries.size
    },
  }
}

// A single limiter for a set of endpoints, keyed by a caller-supplied string.
export function createLimiterSet({ windowMs, max, now } = {}) {
  const limiter = createRateLimiter({ windowMs, max, now })
  return {
    hit(key) {
      return limiter.check(key)
    },
    reset(key) {
      limiter.reset(key)
    },
  }
}
