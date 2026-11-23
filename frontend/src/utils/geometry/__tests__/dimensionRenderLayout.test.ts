import { describe, it, expect } from 'vitest'
import {
  computeLinearArrowLayout, dimensionLineGap, evalExtensionLine, isPointInsideRadius,
  radialWitnessStart, readableLabelAngle,
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

describe('readableLabelAngle', () => {
  // The helper speaks CSS axes (x right, y down) and returns the degrees to
  // hand to `transform: rotate()`, so a positive value tilts the text
  // clockwise on the screen.

  it('leaves a horizontal line at zero', () => {
    expect(readableLabelAngle(10, 0)).toBe(0)
    expect(readableLabelAngle(-10, 0)).toBe(0)
  })

  it('tilts counterclockwise for a line rising to the right', () => {
    // Screen y grows downward, so a rising line has a negative dy.
    expect(readableLabelAngle(10, -5)).toBeCloseTo(-26.565, 3)
  })

  it('tilts clockwise for a line falling to the right', () => {
    expect(readableLabelAngle(10, 5)).toBeCloseTo(26.565, 3)
  })

  it('folds a right-to-left direction onto the same angle, never upside down', () => {
    // The same line read from the other end is the same slope, not the
    // mirrored one.
    expect(readableLabelAngle(-10, 5)).toBeCloseTo(readableLabelAngle(10, -5), 6)
    expect(readableLabelAngle(-10, -5)).toBeCloseTo(readableLabelAngle(10, 5), 6)
  })

  it('reads a vertical line bottom to top whichever way it is traversed', () => {
    // Pinned: 90 is excluded from the fold, so up-the-screen wins.
    expect(readableLabelAngle(0, -1)).toBe(-90)
    expect(readableLabelAngle(0, 1)).toBe(-90)
    // Projection noise just off vertical lands on the same reading, not a 180
    // degree flip across the fold's boundary.
    expect(readableLabelAngle(1e-12, -10)).toBe(-90)
    expect(readableLabelAngle(-1e-12, -10)).toBe(-90)
  })

  it('stays inside [-90, 90) for every direction', () => {
    for (let deg = -180; deg <= 180; deg += 7) {
      const rad = (deg * Math.PI) / 180
      const got = readableLabelAngle(Math.cos(rad), Math.sin(rad))
      expect(got).toBeGreaterThanOrEqual(-90)
      expect(got).toBeLessThan(90)
    }
  })

  it('returns zero for a direction with no screen extent instead of NaN', () => {
    expect(readableLabelAngle(0, 0)).toBe(0)
    expect(readableLabelAngle(NaN, 1)).toBe(0)
    expect(readableLabelAngle(1, Infinity)).toBe(0)
  })
})

describe('dimensionLineGap', () => {
  // A 10 unit dimension line along +X, text 2 world units wide plus padding.
  const D1: [number, number] = [0, 0]
  const D2: [number, number] = [10, 0]
  const GAP = 2
  const TOL = 1

  it('splits the line around a label sitting on it, gap/2 either side', () => {
    const segs = dimensionLineGap(D1, D2, [5, 0], GAP, TOL)
    expect(segs).toHaveLength(2)
    expect(segs[0]).toEqual([[0, 0], [4, 0]])
    expect(segs[1]).toEqual([[6, 0], [10, 0]])
  })

  it('centres the gap on the label along a slanted line', () => {
    // 3-4-5 direction, length 5, label at the midpoint.
    const segs = dimensionLineGap([0, 0], [3, 4], [1.5, 2], 1, 1)
    expect(segs).toHaveLength(2)
    // 0.5 either side of t=2.5 along (3/5, 4/5).
    expect(segs[0][1][0]).toBeCloseTo(1.2, 6)
    expect(segs[0][1][1]).toBeCloseTo(1.6, 6)
    expect(segs[1][0][0]).toBeCloseTo(1.8, 6)
    expect(segs[1][0][1]).toBeCloseTo(2.4, 6)
  })

  it('keeps the whole line for a label dragged off it beyond the tolerance', () => {
    expect(dimensionLineGap(D1, D2, [5, 5], GAP, TOL)).toEqual([[[0, 0], [10, 0]]])
  })

  it('still gaps a label inside the tolerance band', () => {
    expect(dimensionLineGap(D1, D2, [5, 0.5], GAP, TOL)).toHaveLength(2)
  })

  it('drops the whole line, keeping the arrows, when the gap is wider than it', () => {
    expect(dimensionLineGap(D1, D2, [5, 0], 20, TOL)).toEqual([])
  })

  it('keeps the whole line for a label beyond either end', () => {
    expect(dimensionLineGap(D1, D2, [-2, 0], GAP, TOL)).toEqual([[[0, 0], [10, 0]]])
    expect(dimensionLineGap(D1, D2, [12, 0], GAP, TOL)).toEqual([[[0, 0], [10, 0]]])
  })

  it('keeps the whole line when there is no gap to cut', () => {
    expect(dimensionLineGap(D1, D2, [5, 0], 0, TOL)).toEqual([[[0, 0], [10, 0]]])
    expect(dimensionLineGap(D1, D2, [5, 0], -1, TOL)).toEqual([[[0, 0], [10, 0]]])
  })

  it('clamps the split at an end, leaving only the segment that survives', () => {
    // Label exactly on d1: the near half of the gap has nothing left to draw.
    expect(dimensionLineGap(D1, D2, [0, 0], GAP, TOL)).toEqual([[[1, 0], [10, 0]]])
    // Same at d2.
    expect(dimensionLineGap(D1, D2, [10, 0], GAP, TOL)).toEqual([[[0, 0], [9, 0]]])
  })

  it('draws nothing for a zero-length dimension line, never NaN', () => {
    expect(dimensionLineGap([4, 4], [4, 4], [4, 4], 5, TOL)).toEqual([])
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
