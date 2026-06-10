import { describe, it, expect } from 'vitest'
import { sampleEllipse, sampleBezier, getEntityBounds, ellipseAxisPoints } from '@/components/sketch/sketch_helpers'
import type { Ellipse, Spline } from '@/types/cad'

describe('sampleEllipse', () => {
  it('returns a closed polyline of steps+1 points', () => {
    const pts = sampleEllipse(0, 0, 4, 2, 0, 16)
    expect(pts).toHaveLength(17)
    // closed: last == first
    expect(pts[16][0]).toBeCloseTo(pts[0][0])
    expect(pts[16][1]).toBeCloseTo(pts[0][1])
    // all z = 0
    expect(pts.every(p => p[2] === 0)).toBe(true)
  })

  it('axis-aligned ellipse hits its axis vertices', () => {
    // theta=0, a=4, b=2: t=0 -> (4,0); quarter turn -> (0,2).
    const pts = sampleEllipse(0, 0, 4, 2, 0, 4)
    expect(pts[0][0]).toBeCloseTo(4)
    expect(pts[0][1]).toBeCloseTo(0)
    expect(pts[1][0]).toBeCloseTo(0)
    expect(pts[1][1]).toBeCloseTo(2)
  })

  it('every sample lies on the axis-aligned ellipse', () => {
    const a = 5, b = 3
    const pts = sampleEllipse(1, 2, a, b, 0, 32)
    for (const [x, y] of pts) {
      const dx = x - 1, dy = y - 2
      expect((dx * dx) / (a * a) + (dy * dy) / (b * b)).toBeCloseTo(1, 6)
    }
  })

  it('rotation by 90deg swaps the major axis onto +y', () => {
    // a=4 along +y after a 90deg rotation: t=0 maps to (0, 4).
    const pts = sampleEllipse(0, 0, 4, 2, 90, 4)
    expect(pts[0][0]).toBeCloseTo(0)
    expect(pts[0][1]).toBeCloseTo(4)
  })

  it('returns [] for non-finite inputs', () => {
    expect(sampleEllipse(NaN, 0, 4, 2, 0)).toEqual([])
  })
})

describe('sampleBezier', () => {
  it('returns steps+1 points with z=0, anchored at P1 and P4', () => {
    const pts = sampleBezier([0, 0], [1, 3], [3, 3], [4, 0], 16)
    expect(pts).toHaveLength(17)
    expect(pts[0][0]).toBeCloseTo(0)
    expect(pts[0][1]).toBeCloseTo(0)
    expect(pts[16][0]).toBeCloseTo(4)
    expect(pts[16][1]).toBeCloseTo(0)
    expect(pts.every(p => p[2] === 0)).toBe(true)
  })

  it('passes through the analytic midpoint B(0.5) = (P1 + 3P2 + 3P3 + P4)/8', () => {
    const pts = sampleBezier([0, 0], [0, 3], [3, 3], [3, 0], 2)
    // even step count -> pts[1] is exactly t=0.5
    expect(pts[1][0]).toBeCloseTo(1.5)
    expect(pts[1][1]).toBeCloseTo(2.25)
  })

  it('a degenerate Bezier with collinear evenly-spaced points is the straight line', () => {
    const pts = sampleBezier([0, 0], [1, 0], [2, 0], [3, 0], 3)
    expect(pts.map(p => p[0])).toEqual([0, 1, 2, 3])
    expect(pts.every(p => p[1] === 0)).toBe(true)
  })

  it('returns [] for non-finite inputs', () => {
    expect(sampleBezier([NaN, 0], [1, 1], [2, 1], [3, 0])).toEqual([])
  })
})

describe('getEntityBounds for spline', () => {
  it('bounds the curve by its control polygon', () => {
    const sp: Spline = { p1: [0, 0], p2: [1, 5], p3: [3, -2], p4: [4, 1] }
    const b = getEntityBounds(sp)
    expect(b.minX).toBe(0)
    expect(b.maxX).toBe(4)
    expect(b.minY).toBe(-2)
    expect(b.maxY).toBe(5)
  })
})

describe('ellipseAxisPoints', () => {
  it('axis-aligned: major along x, minor along y, distance = a / b from center', () => {
    const ap = ellipseAxisPoints(1, 2, 4, 2, 0)
    expect(ap.major1[0]).toBeCloseTo(5); expect(ap.major1[1]).toBeCloseTo(2)
    expect(ap.major2[0]).toBeCloseTo(-3); expect(ap.major2[1]).toBeCloseTo(2)
    expect(ap.minor1[0]).toBeCloseTo(1); expect(ap.minor1[1]).toBeCloseTo(4)
    expect(ap.minor2[0]).toBeCloseTo(1); expect(ap.minor2[1]).toBeCloseTo(0)
    // distance center->major1 == a, center->minor1 == b (this is what dimensions pin)
    expect(Math.hypot(ap.major1[0] - 1, ap.major1[1] - 2)).toBeCloseTo(4)
    expect(Math.hypot(ap.minor1[0] - 1, ap.minor1[1] - 2)).toBeCloseTo(2)
  })

  it('rotated 90deg swaps major onto +y', () => {
    const ap = ellipseAxisPoints(0, 0, 4, 2, 90)
    expect(ap.major1[0]).toBeCloseTo(0); expect(ap.major1[1]).toBeCloseTo(4)
    expect(ap.minor1[0]).toBeCloseTo(-2); expect(ap.minor1[1]).toBeCloseTo(0)
  })
})

describe('getEntityBounds for ellipse', () => {
  it('axis-aligned ellipse bounds match semi-axes', () => {
    const el: Ellipse = { center: [1, 2], a: 4, b: 2, theta: 0 }
    const b = getEntityBounds(el)
    expect(b.minX).toBeCloseTo(-3)
    expect(b.maxX).toBeCloseTo(5)
    expect(b.minY).toBeCloseTo(0)
    expect(b.maxY).toBeCloseTo(4)
  })

  it('90deg-rotated ellipse swaps width and height extents', () => {
    const el: Ellipse = { center: [0, 0], a: 4, b: 2, theta: 90 }
    const bd = getEntityBounds(el)
    expect(bd.maxX).toBeCloseTo(2)
    expect(bd.maxY).toBeCloseTo(4)
  })
})
