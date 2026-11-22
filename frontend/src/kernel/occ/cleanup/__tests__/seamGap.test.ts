import { describe, it, expect } from 'vitest'
import { largestFreeGap, MIN_SEAM_GAP } from '../seamGap'

describe('largestFreeGap', () => {
  it('places a seam anywhere when the circle is empty', () => {
    expect(largestFreeGap([])).toBe(0)
  })

  it('finds the gap that wraps past the period mark', () => {
    // Two angles hug 0 from either side; the free arc runs from 0.1 past pi.
    const seam = largestFreeGap([0.1, -0.1], (20 * Math.PI) / 180)
    expect(seam).not.toBeNull()
    expect(seam! > Math.PI - 0.11 && seam! < Math.PI + 0.11).toBe(true)
  })

  it('returns the middle of the largest gap', () => {
    // Gaps: 0.1, pi - 0.1 and pi (from pi to 2pi).
    expect(largestFreeGap([0, 0.1, Math.PI])).toBeCloseTo(1.5 * Math.PI, 12)
  })

  it('refuses a gap narrower than the minimum', () => {
    // Twelve evenly spaced boundary angles leave 30 degree gaps, just above the
    // floor; sixteen leave 22.5 degrees, still above it. Use 5 degree steps to
    // fall below 20 degrees.
    const dense = Array.from({ length: 72 }, (_, i) => (i * 5 * Math.PI) / 180)
    expect(largestFreeGap(dense, MIN_SEAM_GAP)).toBeNull()
  })

  it('accepts a gap exactly at the minimum', () => {
    const atMin = [0, MIN_SEAM_GAP]
    expect(largestFreeGap(atMin, MIN_SEAM_GAP)).not.toBeNull()
  })

  it('rejects a non-finite angle instead of guessing', () => {
    expect(largestFreeGap([0, Number.NaN])).toBeNull()
    expect(largestFreeGap([0, Number.POSITIVE_INFINITY])).toBeNull()
  })

  it('defaults to the seam gap floor', () => {
    const dense = Array.from({ length: 72 }, (_, i) => (i * 5 * Math.PI) / 180)
    expect(largestFreeGap(dense)).toBeNull()
  })
})
