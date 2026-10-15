import { describe, it, expect } from 'vitest'
import { runSeedsBounded } from './sweep'

describe('runSeedsBounded', () => {
  it('returns every seed result exactly once, in seed order, at any width', async () => {
    for (const workers of [1, 2, 3, 8]) {
      const out = await runSeedsBounded(10, workers, async (seed) => {
        // Seed-dependent replies land out of order at width > 1; the slotting
        // is what restores the seed order.
        await new Promise((resolve) => setTimeout(resolve, (seed * 7) % 3))
        return seed * 2
      })
      expect(out).toEqual(Array.from({ length: 10 }, (_value, seed) => seed * 2))
    }
  })

  it('never runs more than `workers` recipes at once', async () => {
    let inFlight = 0
    let peak = 0
    await runSeedsBounded(12, 3, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight--
      return null
    })
    expect(peak).toBe(3)
  })

  it('caps the width at the seed count', async () => {
    let inFlight = 0
    let peak = 0
    await runSeedsBounded(2, 8, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await Promise.resolve()
      inFlight--
      return null
    })
    expect(peak).toBe(2)
  })

  it('propagates a failing seed', async () => {
    await expect(
      runSeedsBounded(5, 2, async (seed) => {
        if (seed === 3) throw new Error('seed 3 failed')
        return seed
      }),
    ).rejects.toThrow('seed 3 failed')
  })
})
