import { describe, it, expect } from 'vitest'
import {
  computeLinearArrowLayout, evalExtensionLine, isPointInsideRadius, radialWitnessStart,
} from '../dimensionRenderLayout'

describe('computeLinearArrowLayout', () => {
  it('reads the label as inside when it projects between d1 and d2', () => {
    const g = computeLinearArrowLayout([0, 0], [10, 0], [5, 0])
    expect(g.dimLen).toBeCloseTo(10, 6)
    expect(g.udirX).toBeCloseTo(1, 6)
    expect(g.udirY).toBeCloseTo(0, 6)
    expect(g.tLabel).toBeCloseTo(5, 6)
    expect(g.isInside).toBe(true)
  })

  it('reads the label as outside, before d1, when it projects negative', () => {
    const g = computeLinearArrowLayout([0, 0], [10, 0], [-3, 0])
    expect(g.tLabel).toBeCloseTo(-3, 6)
    expect(g.isInside).toBe(false)
  })

  it('reads the label as outside, past d2, when it projects beyond dimLen', () => {
    const g = computeLinearArrowLayout([0, 0], [10, 0], [15, 0])
    expect(g.tLabel).toBeCloseTo(15, 6)
    expect(g.isInside).toBe(false)
  })

  it('treats exactly-at-the-boundary labels as inside (closed interval)', () => {
    const atD1 = computeLinearArrowLayout([0, 0], [10, 0], [0, 0])
    const atD2 = computeLinearArrowLayout([0, 0], [10, 0], [10, 0])
    expect(atD1.isInside).toBe(true)
    expect(atD2.isInside).toBe(true)
  })

  it('falls back to +X direction for a zero-length dimension line, never NaN', () => {
    const g = computeLinearArrowLayout([4, 4], [4, 4], [4, 4])
    expect(g.dimLen).toBe(0)
    expect(g.udirX).toBe(1)
    expect(g.udirY).toBe(0)
    expect(g.tLabel).toBe(0)
    expect(g.isInside).toBe(true)
    expect(Number.isFinite(g.tLabel)).toBe(true)
  })

  it('projects correctly along a non-axis-aligned dimension line', () => {
    // d1->d2 along the (3,4)/5 direction, length 5; label at the midpoint offset perpendicular.
    const g = computeLinearArrowLayout([0, 0], [3, 4], [1.5, 2])
    expect(g.dimLen).toBeCloseTo(5, 6)
    expect(g.tLabel).toBeCloseTo(2.5, 6)
    expect(g.isInside).toBe(true)
  })
})

describe('evalExtensionLine', () => {
  it('skips when the dimension endpoint already projects onto the segment', () => {
    // Segment (0,0)-(10,0); dim endpoint at (5, 0) lies exactly on it.
    const r = evalExtensionLine(0, 0, 10, 0, 5, 0)
    expect(r.skip).toBe(true)
    expect(r.touchX).toBeCloseTo(5, 6)
    expect(r.touchY).toBeCloseTo(0, 6)
  })

  it('does not skip when the dimension endpoint is off the segment', () => {
    // Segment (0,0)-(10,0); dim endpoint at (5, 3) is 3 units off it.
    const r = evalExtensionLine(0, 0, 10, 0, 5, 3)
    expect(r.skip).toBe(false)
    expect(r.touchX).toBeCloseTo(5, 6)
    expect(r.touchY).toBeCloseTo(0, 6)
  })

  it('clamps the touch point to the segment when the endpoint projects beyond it', () => {
    const r = evalExtensionLine(0, 0, 10, 0, 15, 3)
    expect(r.touchX).toBeCloseTo(10, 6)  // clamped to t=1
    expect(r.touchY).toBeCloseTo(0, 6)
    expect(r.skip).toBe(false)
  })

  it('skips a zero-length segment, touching its own point, never NaN', () => {
    const r = evalExtensionLine(2, 3, 2, 3, 9, 9)
    expect(r.skip).toBe(true)
    expect(r.touchX).toBe(2)
    expect(r.touchY).toBe(3)
    expect(Number.isFinite(r.touchX) && Number.isFinite(r.touchY)).toBe(true)
  })

  it('is right at the skip/no-skip tolerance boundary just past 0.001 squared distance', () => {
    // Segment (0,0)-(10,0); dim endpoint 0.032 units off (0.032^2 ≈ 0.001024 > 0.001).
    const justOutside = evalExtensionLine(0, 0, 10, 0, 5, 0.032)
    expect(justOutside.skip).toBe(false)
    // 0.03 units off (0.03^2 = 0.0009 < 0.001) should skip.
    const justInside = evalExtensionLine(0, 0, 10, 0, 5, 0.03)
    expect(justInside.skip).toBe(true)
  })
})

describe('isPointInsideRadius', () => {
  it('is inside when the point sits within the radius', () => {
    expect(isPointInsideRadius(3, 0, 0, 0, 5)).toBe(true)
  })

  it('is outside when the point sits beyond the radius', () => {
    expect(isPointInsideRadius(8, 0, 0, 0, 5)).toBe(false)
  })

  it('is inside exactly on the boundary (closed interval)', () => {
    expect(isPointInsideRadius(5, 0, 0, 0, 5)).toBe(true)
  })

  it('reads a point at the center as inside a collapsed (zero) radius', () => {
    expect(isPointInsideRadius(0, 0, 0, 0, 0)).toBe(true)
  })

  it('reads any off-center point as outside a collapsed (zero) radius', () => {
    expect(isPointInsideRadius(0.001, 0, 0, 0, 0)).toBe(false)
  })
})

describe('radialWitnessStart', () => {
  // Vertex at origin, ray along +X (angle 0). Measured segment spans s in [2, 6]
  // along that ray.
  const vx = 0, vy = 0, ang = 0
  const px1 = 2, py1 = 0, px2 = 6, py2 = 0

  it('returns null when the arc radius falls within the measured span', () => {
    expect(radialWitnessStart(vx, vy, 4, px1, py1, px2, py2, ang)).toBeNull()
  })

  it('returns null exactly at the span boundary (closed interval, no witness)', () => {
    expect(radialWitnessStart(vx, vy, 2, px1, py1, px2, py2, ang)).toBeNull()
    expect(radialWitnessStart(vx, vy, 6, px1, py1, px2, py2, ang)).toBeNull()
  })

  it('starts the witness at the far span boundary when the arc is beyond it', () => {
    const w = radialWitnessStart(vx, vy, 10, px1, py1, px2, py2, ang)
    expect(w).not.toBeNull()
    expect(w![0]).toBeCloseTo(6, 6)
    expect(w![1]).toBeCloseTo(0, 6)
  })

  it('starts the witness at the near span boundary when the arc is short of it', () => {
    const w = radialWitnessStart(vx, vy, 1, px1, py1, px2, py2, ang)
    expect(w).not.toBeNull()
    expect(w![0]).toBeCloseTo(2, 6)
    expect(w![1]).toBeCloseTo(0, 6)
  })

  it('handles a segment given back-to-front (s1 > s2) via the min/max normalization', () => {
    // Same segment, endpoints swapped -- s1=6, s2=2. Behavior must be identical.
    const w = radialWitnessStart(vx, vy, 10, px2, py2, px1, py1, ang)
    expect(w).not.toBeNull()
    expect(w![0]).toBeCloseTo(6, 6)
  })

  it('works along a non-axis-aligned ray', () => {
    // Ray at 90 degrees (+Y). Segment spans s in [2, 6] along +Y from origin.
    const ang90 = Math.PI / 2
    const w = radialWitnessStart(0, 0, 10, 0, 2, 0, 6, ang90)
    expect(w).not.toBeNull()
    expect(w![0]).toBeCloseTo(0, 6)
    expect(w![1]).toBeCloseTo(6, 6)
  })

  it('offsets correctly from a non-origin vertex', () => {
    const w = radialWitnessStart(100, 50, 10, 102, 50, 106, 50, ang)
    expect(w).not.toBeNull()
    expect(w![0]).toBeCloseTo(106, 6)
    expect(w![1]).toBeCloseTo(50, 6)
  })
})
