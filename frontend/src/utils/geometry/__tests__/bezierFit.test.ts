import { describe, it, expect } from 'vitest'
import { fitCubicBezier } from '@/utils/geometry/bezierFit'
import { sampleBezier } from '@/components/sketch/sketch_helpers'

type P2 = [number, number]

describe('fitCubicBezier', () => {
  it('returns null for fewer than two points', () => {
    expect(fitCubicBezier([])).toBeNull()
    expect(fitCubicBezier([[0, 0]])).toBeNull()
  })

  it('pins the endpoints to the first and last sample', () => {
    const pts: P2[] = [[0, 0], [1, 2], [3, 1], [4, 0]]
    const fit = fitCubicBezier(pts)!
    expect(fit[0]).toBeCloseTo(0)
    expect(fit[1]).toBeCloseTo(0)
    expect(fit[6]).toBeCloseTo(4)
    expect(fit[7]).toBeCloseTo(0)
  })

  it('fits a curve sampled from a known cubic to within a tight tolerance', () => {
    // Sample a known (steep) cubic, fit from those samples, then compare the
    // fitted curve to a DENSE reference of the original. Reparameterization
    // brings the geometric deviation well under a hundredth of a unit.
    const p1: P2 = [0, 0], p2: P2 = [1, 4], p3: P2 = [5, 4], p4: P2 = [6, 0]
    const samples = sampleBezier(p1, p2, p3, p4, 40).map((p) => [p[0], p[1]] as P2)
    const reference = sampleBezier(p1, p2, p3, p4, 400)
    const fit = fitCubicBezier(samples)!
    const refit = sampleBezier(
      [fit[0], fit[1]], [fit[2], fit[3]], [fit[4], fit[5]], [fit[6], fit[7]], 400,
    )
    // Geometric closeness: chord-length and uniform parameterizations trace the
    // same shape at different speeds, so compare each fitted point to the
    // nearest point on the dense reference rather than index-by-index.
    let maxDev = 0
    for (const r of refit) {
      let best = Infinity
      for (const s of reference) best = Math.min(best, Math.hypot(r[0] - s[0], r[1] - s[1]))
      maxDev = Math.max(maxDev, best)
    }
    expect(maxDev).toBeLessThan(0.02)
  })

  it('fits a straight polyline as a near-straight curve', () => {
    const pts: P2[] = [[0, 0], [1, 0], [2, 0], [3, 0]]
    const fit = fitCubicBezier(pts)!
    // All control points lie on the x-axis.
    expect(fit[1]).toBeCloseTo(0)
    expect(fit[3]).toBeCloseTo(0)
    expect(fit[5]).toBeCloseTo(0)
    expect(fit[7]).toBeCloseTo(0)
  })

  it('handles two points by placing controls at the chord thirds', () => {
    const fit = fitCubicBezier([[0, 0], [3, 3]])!
    expect(fit).toEqual([0, 0, 1, 1, 2, 2, 3, 3])
  })

  it('handles coincident samples without blowing up (degenerate fallback)', () => {
    const fit = fitCubicBezier([[1, 1], [1, 1], [1, 1]])!
    expect(fit.every((n) => Number.isFinite(n))).toBe(true)
    expect(fit[0]).toBeCloseTo(1)
    expect(fit[6]).toBeCloseTo(1)
  })
})
