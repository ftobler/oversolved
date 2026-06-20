// Unit tests for the spline + full-ellipse boundary samplers in profileLoops.
// The existing profileLoops.test.ts covers arcs and elliptical arcs; these two
// pure samplers (used by loopPts so a standalone closed spline / ellipse reads
// as a polygon) had no direct coverage. No OCC.

import { describe, it, expect } from 'vitest'
import { splineSamplePoints, ellipseSamplePoints, type LoopEdge } from './profileLoops'

describe('splineSamplePoints', () => {
  // A collinear, evenly-spaced control polygon makes the cubic Bezier reduce to
  // a straight reparametrised line, so interior points have exact x = 3t.
  const straight: LoopEdge = {
    kind: 'spline',
    start: [0, 0],
    c1: [1, 0],
    c2: [2, 0],
    end: [3, 0],
  }

  it('returns [] for a non-spline edge', () => {
    expect(splineSamplePoints({ kind: 'line', start: [0, 0], end: [1, 1] }, 3)).toEqual([])
  })

  it('returns [] when a control point is missing', () => {
    expect(splineSamplePoints({ kind: 'spline', start: [0, 0], c1: [1, 0], end: [3, 0] }, 3)).toEqual([])
  })

  it('returns n interior points (endpoints excluded)', () => {
    const pts = splineSamplePoints(straight, 3)
    expect(pts).toHaveLength(3)
    // interior params are 1/4, 2/4, 3/4 -> x = 3t
    expect(pts[0][0]).toBeCloseTo(0.75, 10)
    expect(pts[1][0]).toBeCloseTo(1.5, 10)
    expect(pts[2][0]).toBeCloseTo(2.25, 10)
    for (const p of pts) expect(p[1]).toBeCloseTo(0, 10)
  })

  it('puts the single sample at the t=1/2 midpoint', () => {
    const [p] = splineSamplePoints(straight, 1)
    expect(p[0]).toBeCloseTo(1.5, 10)
    expect(p[1]).toBeCloseTo(0, 10)
  })

  it('evaluates a genuinely curved spline via the cubic basis', () => {
    // symmetric arch: both control handles lifted to y=1 -> de Casteljau midpoint
    // y = 3/4 (b+c weights at t=1/2 are 0.375 each, applied to c1.y=c2.y=1).
    const arch: LoopEdge = { kind: 'spline', start: [0, 0], c1: [0, 1], c2: [2, 1], end: [2, 0] }
    const [p] = splineSamplePoints(arch, 1)
    expect(p[0]).toBeCloseTo(1, 10)
    expect(p[1]).toBeCloseTo(0.75, 10)
  })

  it('returns no points when n is 0', () => {
    expect(splineSamplePoints(straight, 0)).toEqual([])
  })
})

describe('ellipseSamplePoints', () => {
  const ell: LoopEdge = { kind: 'ellipse', center: [0, 0], a: 2, b: 1, theta: 0 }

  it('returns [] for a non-ellipse edge', () => {
    expect(ellipseSamplePoints({ kind: 'circle', center: [0, 0], radius: 1 }, 8)).toEqual([])
  })

  it('returns [] when center is missing', () => {
    expect(ellipseSamplePoints({ kind: 'ellipse', a: 2, b: 1 }, 8)).toEqual([])
  })

  it('samples the full closed ellipse starting at the major-axis tip', () => {
    const pts = ellipseSamplePoints(ell, 4)
    expect(pts).toHaveLength(4)
    // t = 0, pi/2, pi, 3pi/2 around an axis-aligned a=2,b=1 ellipse
    expect(pts[0][0]).toBeCloseTo(2, 10);  expect(pts[0][1]).toBeCloseTo(0, 10)
    expect(pts[1][0]).toBeCloseTo(0, 10);  expect(pts[1][1]).toBeCloseTo(1, 10)
    expect(pts[2][0]).toBeCloseTo(-2, 10); expect(pts[2][1]).toBeCloseTo(0, 10)
    expect(pts[3][0]).toBeCloseTo(0, 10);  expect(pts[3][1]).toBeCloseTo(-1, 10)
  })

  it('applies the theta rotation about the center', () => {
    // theta = 90deg rotates the major tip (2,0) to (0,2)
    const rotated: LoopEdge = { kind: 'ellipse', center: [0, 0], a: 2, b: 1, theta: 90 }
    const [tip] = ellipseSamplePoints(rotated, 4)
    expect(tip[0]).toBeCloseTo(0, 10)
    expect(tip[1]).toBeCloseTo(2, 10)
  })

  it('offsets every sample by the center', () => {
    const shifted: LoopEdge = { kind: 'ellipse', center: [10, -5], a: 2, b: 1, theta: 0 }
    const [tip] = ellipseSamplePoints(shifted, 4)
    expect(tip[0]).toBeCloseTo(12, 10)
    expect(tip[1]).toBeCloseTo(-5, 10)
  })

  it('collapses to the center point when the semi-axes default to zero', () => {
    const degenerate: LoopEdge = { kind: 'ellipse', center: [3, 4] }
    const pts = ellipseSamplePoints(degenerate, 5)
    expect(pts).toHaveLength(5)
    for (const p of pts) {
      expect(p[0]).toBeCloseTo(3, 10)
      expect(p[1]).toBeCloseTo(4, 10)
    }
  })
})
