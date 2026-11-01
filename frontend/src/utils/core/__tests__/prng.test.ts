import { describe, it, expect } from 'vitest'
import { makePrng } from '@/utils/core/prng'

// The fuzz seed ratchet and every drive journal depend on this exact stream:
// a change to the arithmetic would silently replay different documents for the
// same pinned seed. These values are the first draws of the stream the three
// former copies produced, kept as the freeze, not as test data to update.
const PINNED = {
  0: [0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111],
  1: [0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741],
  990: [0.8008275981992483, 0.6351146074011922, 0.2630751628894359, 0.11140116071328521],
} as const

describe('makePrng', () => {
  for (const [seed, expected] of Object.entries(PINNED)) {
    it(`draws the frozen stream for seed ${seed}`, () => {
      const rnd = makePrng(Number(seed))
      for (const value of expected) expect(rnd()).toBe(value)
    })
  }

  it('draws in [0, 1)', () => {
    const rnd = makePrng(7)
    for (let i = 0; i < 1000; i++) {
      const value = rnd()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})
