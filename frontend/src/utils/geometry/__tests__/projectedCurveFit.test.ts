// The adaptive fit behind a projected curve: it must stop as soon as every span
// follows the truth, must stop at the fit-point cap with a warning rather than
// refusing, and its two deviation readers are the measure the projection uses
// to pick between one cubic and a fit spline.
import { describe, it, expect } from 'vitest'
import {
  adaptiveFitPoints,
  curveScale,
  isClosedLoop,
  lowerProjectedCurve,
  maxDeviationToCubic,
  maxDeviationToFitSpline,
  PROJECTED_CURVE_FIT_TOL,
} from '../projectedCurveFit'
import { MAX_FIT_POINTS, interpolateFitSpline, type Pt } from '../fitSpline'

function circleSamples(radius: number, steps: number): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i <= steps; i++) {
    const t = (2 * Math.PI * i) / steps
    out.push([radius * Math.cos(t), radius * Math.sin(t)])
  }
  return out
}

/** A polyline that alternates up and down every sample: no smooth cubic spline
 *  can follow it between the samples it interpolates. */
function zigzag(steps: number, amplitude: number): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i <= steps; i++) out.push([i / steps, i % 2 === 0 ? amplitude : -amplitude])
  return out
}

describe('adaptiveFitPoints', () => {
  it('stops as soon as every span follows the curve, not at the sample count', () => {
    const truth = circleSamples(5, 128)
    const fit = adaptiveFitPoints(truth, 1.5e-3 * curveScale(truth))
    expect(fit.converged).toBe(true)
    // A circle needs a handful of spans at this rung, so using all 129 samples
    // would mean the bisection never converged and fell through to the end.
    expect(fit.points.length).toBeLessThan(32)
    expect(maxDeviationToFitSpline(truth, fit.points)).toBeLessThanOrEqual(1.5e-3 * curveScale(truth))
  })

  it('keeps the last fit and reports the cap when the tolerance is unreachable', () => {
    const truth = zigzag(128, 1)
    const fit = adaptiveFitPoints(truth, 0)
    expect(fit.converged).toBe(false)
    expect(fit.points).toHaveLength(MAX_FIT_POINTS)
  })

  it('is deterministic', () => {
    const truth = circleSamples(4, 96)
    expect(adaptiveFitPoints(truth, 1e-2)).toEqual(adaptiveFitPoints(truth, 1e-2))
  })
})

function pairs(flat: readonly number[]): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]])
  return out
}

describe('lowerProjectedCurve', () => {
  it('closes a source whose last sample is bit-identical to its first', () => {
    // The headline closed-source case: a sampled loop that repeats its first
    // point literally. Fitting the open chain and restoring the closure keeps
    // this a real loop instead of a zero-extent two-point edge.
    const truth = circleSamples(3, 32)
    truth[truth.length - 1] = [truth[0][0], truth[0][1]]
    const out = lowerProjectedCurve(truth, truth)!
    expect(out.kind).toBe('fit_spline')
    expect(out.params.length).toBeGreaterThan(4)
    expect(out.warning).toBeUndefined()
    const points = pairs(out.params)
    expect(points[points.length - 1]).toEqual(points[0])
    expect(maxDeviationToFitSpline(truth, points)).toBeLessThanOrEqual(
      PROJECTED_CURVE_FIT_TOL * curveScale(truth),
    )
  })

  it('keeps a nearly closed source open', () => {
    // A 0.1 degree gap is far above the loop-closure rung, so this arc must not
    // be welded into a closed loop by the fit tolerance.
    const steps = 200
    const sweep = 2 * Math.PI * (359.9 / 360)
    const truth: Pt[] = []
    for (let i = 0; i <= steps; i++) {
      const t = (sweep * i) / steps
      truth.push([3 * Math.cos(t), 3 * Math.sin(t)])
    }
    const out = lowerProjectedCurve(truth, truth)!
    expect(out.kind).toBe('fit_spline')
    const points = pairs(out.params)
    const gap = Math.hypot(
      points[points.length - 1][0] - points[0][0],
      points[points.length - 1][1] - points[0][1],
    )
    expect(gap).toBeGreaterThan(1e-3)
  })

  it('meets the tolerance on a dense payload without keeping every sample', () => {
    // A helix or B-spline payload can carry thousands of samples; the truth is
    // decimated to the conic grid, so the re-solve cost does not scale with it.
    const truth = circleSamples(4, 2000)
    truth[truth.length - 1] = [truth[0][0], truth[0][1]]
    const out = lowerProjectedCurve(truth, truth)!
    expect(out.kind).toBe('fit_spline')
    expect(out.warning).toBeUndefined()
    expect(out.params.length / 2).toBeLessThan(MAX_FIT_POINTS)
    const points = pairs(out.params)
    expect(points[points.length - 1]).toEqual(points[0])
    expect(maxDeviationToFitSpline(truth, points)).toBeLessThanOrEqual(
      PROJECTED_CURVE_FIT_TOL * curveScale(truth),
    )
  })

  it('warns and keeps the best fit when the cap is hit', () => {
    const truth = zigzag(200, 1)
    const out = lowerProjectedCurve(truth, truth)!
    expect(out.kind).toBe('fit_spline')
    expect(out.params.length / 2).toBeLessThanOrEqual(MAX_FIT_POINTS)
    expect(out.warning).toContain('the closest fit is kept')
  })

  it('keeps a closed fit inside the 64 point block when the cap is hit', () => {
    // A 100-tooth star, closed literally: no 63-span spline can follow it, so
    // the open chain hits its cap. The closure adds one point, and the closed
    // block must still pass the 64-point document limit and interpolate.
    const truth: Pt[] = []
    const steps = 200
    for (let i = 0; i <= steps; i++) {
      const t = (2 * Math.PI * i) / steps
      const radius = i % 2 === 0 ? 3 : 2
      truth.push([radius * Math.cos(t), radius * Math.sin(t)])
    }
    truth[truth.length - 1] = [truth[0][0], truth[0][1]]
    const out = lowerProjectedCurve(truth, truth)!
    expect(out.kind).toBe('fit_spline')
    expect(out.params.length / 2).toBe(MAX_FIT_POINTS)
    // 63 distinct fit points plus the repeated closure point: the warning names
    // the distinct set, the block carries all 64.
    expect(out.warning).toContain('at 63 fit points')
    const points = pairs(out.params)
    expect(points[points.length - 1]).toEqual(points[0])
    expect(() => interpolateFitSpline(points)).not.toThrow()
  })

  it('accepts a three-sample closed loop as the minimum-information loop', () => {
    // Two distinct samples: the open chain is a single span with no interior
    // point to contradict the tolerance, so the closed fit is that span plus
    // the repeated start. It is degenerate by construction, not by a fallback.
    const truth: Pt[] = [[0, 0], [2, 1], [0, 0]]
    const out = lowerProjectedCurve(truth, truth)!
    expect(out.kind).toBe('fit_spline')
    expect(out.warning).toBeUndefined()
    expect(out.params.length / 2).toBe(3)
    const points = pairs(out.params)
    expect(points[points.length - 1]).toEqual(points[0])
  })

  it('returns null with no curve to lower', () => {
    expect(lowerProjectedCurve([], [])).toBeNull()
    expect(lowerProjectedCurve([[1, 2]], [[1, 2]])).toBeNull()
  })
})

describe('deviation readers', () => {
  it('read a cubic measured against itself as zero', () => {
    const ctrl: Pt[] = [[0, 0], [1, 3], [4, 3], [5, 0]]
    const samples: Pt[] = []
    for (let i = 0; i <= 32; i++) {
      const t = i / 32
      const mt = 1 - t
      samples.push([
        mt * mt * mt * ctrl[0][0] + 3 * mt * mt * t * ctrl[1][0] + 3 * mt * t * t * ctrl[2][0] + t * t * t * ctrl[3][0],
        mt * mt * mt * ctrl[0][1] + 3 * mt * mt * t * ctrl[1][1] + 3 * mt * t * t * ctrl[2][1] + t * t * t * ctrl[3][1],
      ])
    }
    expect(maxDeviationToCubic(samples, ctrl)).toBeLessThan(1e-12)
  })

  it('measure a curve size and closure from the samples', () => {
    const square: Pt[] = [[0, 0], [3, 0], [3, 4], [0, 4], [0, 0]]
    expect(curveScale(square)).toBeCloseTo(5)
    expect(isClosedLoop(square, 1e-6)).toBe(true)
    expect(isClosedLoop([[0, 0], [3, 0], [3, 4], [0, 4]], 1e-6)).toBe(false)
  })

  it('reads the interpolating spline through its own fit points as zero', () => {
    const points: Pt[] = [[0, 0], [1, 2], [2, -2], [3, 0]]
    const curve = interpolateFitSpline(points)
    const end = curve.knots[curve.knots.length - 1]
    const samples: Pt[] = []
    for (let i = 0; i <= 32; i++) samples.push(curve.eval((end * i) / 32))
    expect(maxDeviationToFitSpline(samples, points)).toBeLessThan(1e-12)
  })
})
