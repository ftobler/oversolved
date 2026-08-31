import { describe, it, expect } from 'vitest'
import { getPixelRatio } from '../pickPixelRatio'

/**
 * The driver's half of the CSS-to-device scale. The pipeline's half is well
 * covered; this one -- where the number actually comes from -- was not covered
 * at all, so the guard below could have been deleted without a failure.
 */
describe('getPixelRatio', () => {
  it('is the drawing buffer over the CSS width', () => {
    expect(getPixelRatio(1600, 800)).toBe(2)
    expect(getPixelRatio(800, 800)).toBe(1)
    expect(getPixelRatio(2400, 800)).toBe(3)
    expect(getPixelRatio(1200, 800)).toBe(1.5)
  })

  it('falls back to 1 when the canvas has not been measured yet', () => {
    // R3F reports size 1 before the canvas measures. Taken literally against a
    // real drawing buffer that is a ratio in the hundreds; the pipeline clamps
    // it, so the cost would only ever be a needlessly large readback, but the
    // nonsense is recognisable here and belongs here.
    expect(getPixelRatio(1600, 1)).toBe(1)
    expect(getPixelRatio(1600, 0)).toBe(1)
    expect(getPixelRatio(1600, 15)).toBe(1)
  })

  it('accepts the smallest plausible canvas', () => {
    expect(getPixelRatio(32, 16)).toBe(2)
  })
})
