import { describe, it, expect } from 'vitest'
import { proximityGain } from '../utils/webrtc.js'
import { pctToPixels, pixelDistance, EARSHOT_RADIUS_PX } from '../utils/collision.js'

// These tests cover the exact attenuation curve the client applies to a remote
// peer's gain node. They deliberately do not claim anything about real audio
// capture or playback: they only pin the math that turns avatar distance into
// gain, using the same pixel helpers the UI uses.
describe('client proximity gain', () => {
  const defaults = { earshotPx: 100, minVolume: 0.1, maxVolume: 1.0 }

  it('is fully loud at zero distance', () => {
    expect(proximityGain(0, defaults)).toBe(1)
  })

  it('is silent at and beyond the earshot radius', () => {
    expect(proximityGain(EARSHOT_RADIUS_PX, defaults)).toBe(0)
    expect(proximityGain(EARSHOT_RADIUS_PX + 1, defaults)).toBe(0)
    expect(proximityGain(5000, defaults)).toBe(0)
  })

  it('falls off linearly between the two avatars', () => {
    expect(proximityGain(25, defaults)).toBeCloseTo(0.775, 5)
    expect(proximityGain(50, defaults)).toBeCloseTo(0.55, 5)
    expect(proximityGain(99, defaults)).toBeCloseTo(0.109, 3)
  })

  it('never exceeds maxVolume or drops below 0', () => {
    expect(proximityGain(-40, defaults)).toBeLessThanOrEqual(1)
    expect(proximityGain(0, { ...defaults, maxVolume: 0.8 })).toBe(0.8)
    for (const d of [-100, 0, 10, 99, 100, 1e6, NaN, Infinity]) {
      const gain = proximityGain(d, defaults)
      expect(gain).toBeGreaterThanOrEqual(0)
      expect(gain).toBeLessThanOrEqual(1)
    }
  })

  it('honours a custom earshot and floor volume', () => {
    expect(proximityGain(100, { earshotPx: 200, minVolume: 0.1, maxVolume: 1 })).toBeCloseTo(0.55, 5)
    expect(proximityGain(150, { earshotPx: 200, minVolume: 0.2, maxVolume: 1 })).toBeCloseTo(0.4, 5)
  })

  it('uses the real pixel distance between two avatars on a real floor', () => {
    // 900x540 floor: avatar at 50%,50% -> (450,270); peer at 55%,50% -> (495,270).
    // Pixel distance is 45, i.e. 45% of the 100px earshot.
    const floor = { width: 900, height: 540 }
    const me = pctToPixels(50, 50, floor.width, floor.height)
    const peer = pctToPixels(55, 50, floor.width, floor.height)
    const distance = pixelDistance({ x: 50, y: 50 }, { x: 55, y: 50 }, floor.width, floor.height)

    expect(distance).toBeCloseTo(45, 6)
    expect(proximityGain(distance, defaults)).toBeCloseTo(0.595, 5)

    // Walking further away reduces the gain monotonically until silence.
    const far = pctToPixels(60, 50, floor.width, floor.height)
    const farDistance = Math.hypot(far.x - me.x, far.y - me.y)
    expect(proximityGain(farDistance, defaults)).toBeLessThan(proximityGain(distance, defaults))
    expect(proximityGain(farDistance, defaults)).toBeCloseTo(0.19, 5)

    // A peer 200px to the right is outside earshot entirely.
    const out = pctToPixels(50 + (200 / floor.width) * 100, 50, floor.width, floor.height)
    expect(proximityGain(Math.hypot(out.x - me.x, out.y - me.y), defaults)).toBe(0)
  })
})
