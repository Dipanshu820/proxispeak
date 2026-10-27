import { describe, it, expect } from 'vitest'
import { positionToGeoJSON, geoJSONToPosition, redactMongoUri, VIRTUAL_COORDS } from './db.js'

const { ORIGIN_LNG: VIRTUAL_ORIGIN_LNG, ORIGIN_LAT: VIRTUAL_ORIGIN_LAT, RANGE_LNG: VIRTUAL_RANGE_LNG, RANGE_LAT: VIRTUAL_RANGE_LAT } = VIRTUAL_COORDS

describe('MongoDB connection-string redaction', () => {
  it('removes credentials before a URI can reach a log line', () => {
    expect(redactMongoUri('mongodb://alice:s3cret@db.example.com:27017/proxispeak')).toBe(
      'mongodb://***@db.example.com:27017/proxispeak',
    )
    expect(redactMongoUri('mongodb+srv://user:p%40ss@cluster.example.net/db')).toBe(
      'mongodb+srv://***@cluster.example.net/db',
    )
  })

  it('leaves credential-free URIs readable', () => {
    expect(redactMongoUri('mongodb://127.0.0.1:27017/proxispeak')).toBe('mongodb://127.0.0.1:27017/proxispeak')
  })

  it('never returns the secret for unusual input', () => {
    expect(redactMongoUri(undefined)).toBe('<unset>')
    expect(redactMongoUri('mongodb://user:pass@')).not.toContain('pass')
  })
})

describe('MongoDB coordinate mapping', () => {
  describe('positionToGeoJSON', () => {
    it('converts 0,0 to virtual origin', () => {
      const geo = positionToGeoJSON(0, 0)
      expect(geo.type).toBe('Point')
      expect(geo.coordinates[0]).toBe(VIRTUAL_ORIGIN_LNG)
      expect(geo.coordinates[1]).toBe(VIRTUAL_ORIGIN_LAT)
    })

    it('converts 100,100 to virtual max', () => {
      const geo = positionToGeoJSON(100, 100)
      expect(geo.type).toBe('Point')
      expect(geo.coordinates[0]).toBe(VIRTUAL_ORIGIN_LNG + VIRTUAL_RANGE_LNG)
      expect(geo.coordinates[1]).toBe(VIRTUAL_ORIGIN_LAT + VIRTUAL_RANGE_LAT)
    })

    it('converts 50,50 to virtual center', () => {
      const geo = positionToGeoJSON(50, 50)
      expect(geo.type).toBe('Point')
      expect(geo.coordinates[0]).toBe(VIRTUAL_ORIGIN_LNG + VIRTUAL_RANGE_LNG / 2)
      expect(geo.coordinates[1]).toBe(VIRTUAL_ORIGIN_LAT + VIRTUAL_RANGE_LAT / 2)
    })

    it('converts 25,75 correctly', () => {
      const geo = positionToGeoJSON(25, 75)
      expect(geo.coordinates[0]).toBe(VIRTUAL_ORIGIN_LNG + VIRTUAL_RANGE_LNG * 0.25)
      expect(geo.coordinates[1]).toBe(VIRTUAL_ORIGIN_LAT + VIRTUAL_RANGE_LAT * 0.75)
    })
  })

  describe('geoJSONToPosition', () => {
    it('converts virtual origin back to 0,0', () => {
      const geo = { type: 'Point', coordinates: [VIRTUAL_ORIGIN_LNG, VIRTUAL_ORIGIN_LAT] }
      const pos = geoJSONToPosition(geo)
      expect(pos.x).toBe(0)
      expect(pos.y).toBe(0)
    })

    it('converts virtual max back to 100,100', () => {
      const geo = { type: 'Point', coordinates: [VIRTUAL_ORIGIN_LNG + VIRTUAL_RANGE_LNG, VIRTUAL_ORIGIN_LAT + VIRTUAL_RANGE_LAT] }
      const pos = geoJSONToPosition(geo)
      expect(pos.x).toBe(100)
      expect(pos.y).toBe(100)
    })

    it('handles invalid geoJSON', () => {
      expect(geoJSONToPosition(null)).toBeNull()
      expect(geoJSONToPosition({ type: 'Polygon' })).toBeNull()
    })
  })

  describe('round-trip conversion', () => {
    it('preserves coordinates through round-trip', () => {
      const testCases = [
        { x: 0, y: 0 },
        { x: 25, y: 25 },
        { x: 50, y: 50 },
        { x: 75, y: 75 },
        { x: 100, y: 100 },
        { x: 33.3, y: 66.7 },
      ]

      for (const { x, y } of testCases) {
        const geo = positionToGeoJSON(x, y)
        const pos = geoJSONToPosition(geo)
        expect(pos.x).toBeCloseTo(x, 5)
        expect(pos.y).toBeCloseTo(y, 5)
      }
    })
  })
})

describe('Database module structure', () => {
  it('exports expected functions', () => {
    // Just verify the module loads correctly
    const dbModule = require('./db.js')
    expect(dbModule).toBeDefined()
    expect(typeof dbModule.connect).toBe('function')
    expect(typeof dbModule.disconnect).toBe('function')
    expect(typeof dbModule.isConnected).toBe('function')
    expect(typeof dbModule.getDb).toBe('function')
  })
})
