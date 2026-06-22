import { describe, it, expect } from 'vitest'
import { computeAngleDimension } from '../angleDimensionLogic'

describe('computeAngleDimension', () => {
  it('places the default arc on the geometry for a corner angle', () => {
    // Line A along +x, line B along +y, sharing the origin (90 degrees).
    const g = computeAngleDimension([0, 0], [10, 0], [0, 0], [0, 10])
    expect(g.vx).toBeCloseTo(0, 6)
    expect(g.vy).toBeCloseTo(0, 6)
    expect(Math.abs(g.arcSpan)).toBeCloseTo(90, 6)
    // Default label sits in the +x/+y quadrant, between the segments.
    expect(g.labelX).toBeGreaterThan(0)
    expect(g.labelY).toBeGreaterThan(0)
    expect(g.isInside).toBe(true)
  })

  it('renders near-parallel lines on the geometry, not at the far vertex', () => {
    // Reproduces the bug report: two nearly-parallel lines whose intersection
    // vertex is far to the right (~x=95). The arc must land on the segments
    // (x in [0,20]), not out near the vertex.
    const A: [[number, number], [number, number]] = [[0, 5], [20, 3.9518444143]]
    const B: [[number, number], [number, number]] = [[0, 0], [20, 0]]
    const g = computeAngleDimension(A[0], A[1], B[0], B[1])
    expect(g.vx).toBeGreaterThan(50)  // vertex is far away
    expect(Math.abs(g.arcSpan)).toBeCloseTo(3, 0)
    // Label lands on the drawn geometry, between the two segments.
    expect(g.labelX).toBeGreaterThan(0)
    expect(g.labelX).toBeLessThan(20)
    expect(g.labelY).toBeGreaterThan(0)
    expect(g.labelY).toBeLessThan(5)
    expect(g.isInside).toBe(true)
  })

  it('follows the label into the quadrant the user dragged toward', () => {
    // Corner at origin, lines along +x and +y. A label offset into the
    // opposite (-x/-y) quadrant should pick that wedge's rays.
    const g = computeAngleDimension([0, 0], [10, 0], [0, 0], [0, 10], [-5, -5])
    expect(g.labelX).toBeLessThan(0)
    expect(g.labelY).toBeLessThan(0)
    expect(Math.abs(g.arcSpan)).toBeCloseTo(90, 6)
    expect(g.isInside).toBe(true)
  })

  it('selects the supplement when the label is dragged off a thin theta wedge', () => {
    // Vertex near (95,0); the theta wedge is only ~3 degrees. A label off that
    // sliver now lands in the wide supplement wedge (the arc the user is aiming
    // at), instead of trailing a leader back to the 3-degree arc as before.
    const A: [[number, number], [number, number]] = [[0, 5], [20, 3.9518444143]]
    const B: [[number, number], [number, number]] = [[0, 0], [20, 0]]
    const g = computeAngleDimension(A[0], A[1], B[0], B[1], [-40, 30])
    expect(g.isSupplement).toBe(true)
    expect(g.isInside).toBe(true)
    expect(Math.abs(g.arcSpan)).toBeCloseTo(177, 0)
  })

  // 30-degree angle used by the quadrant tests: lines along 0 and 30 degrees.
  const A30: [[number, number], [number, number]] = [[0, 0], [10, 0]]
  const B30: [[number, number], [number, number]] = [[0, 0], [Math.cos(Math.PI / 6) * 10, Math.sin(Math.PI / 6) * 10]]
  const at = (deg: number, r = 5): [number, number] =>
    [r * Math.cos((deg * Math.PI) / 180), r * Math.sin((deg * Math.PI) / 180)]

  it('renders the theta wedge when the label points between the lines', () => {
    // Label at 15deg sits in the 0..30 wedge: span ~30, not a supplement.
    const g = computeAngleDimension(A30[0], A30[1], B30[0], B30[1], at(15))
    expect(Math.abs(g.arcSpan)).toBeCloseTo(30, 6)
    expect(g.isSupplement).toBe(false)
    expect(g.isInside).toBe(true)
  })

  it('renders the supplement wedge when the label is dragged past a line', () => {
    // Label at 105deg sits in the 30..180 wedge: span ~150, flagged supplement.
    const g = computeAngleDimension(A30[0], A30[1], B30[0], B30[1], at(105))
    expect(Math.abs(g.arcSpan)).toBeCloseTo(150, 6)
    expect(g.isSupplement).toBe(true)
    expect(g.isInside).toBe(true)
  })

  it('reaches all four quadrants, two theta and two supplement', () => {
    // One label direction inside each of the four wedges around the crossing.
    const probes: Array<[number, boolean]> = [
      [15, false],   // 0..30   theta
      [105, true],   // 30..180 supplement
      [195, false],  // 180..210 theta
      [285, true],   // 210..360 supplement
    ]
    for (const [deg, supplement] of probes) {
      const g = computeAngleDimension(A30[0], A30[1], B30[0], B30[1], at(deg))
      expect(g.isInside).toBe(true)
      expect(g.isSupplement).toBe(supplement)
      expect(Math.abs(g.arcSpan)).toBeCloseTo(supplement ? 150 : 30, 6)
    }
  })

  it('keeps a0 on line A and a1 on line B in every quadrant (witnesses stay matched)', () => {
    // a0deg must always be a line-A ray (0 or 180 mod 180) and a1deg a line-B ray
    // (30 or 210 -> 30 mod 180), so each witness line tracks its own segment.
    const mod180 = (a: number) => (((a % 180) + 180) % 180)
    for (let deg = 5; deg < 360; deg += 10) {
      const g = computeAngleDimension(A30[0], A30[1], B30[0], B30[1], at(deg))
      expect(mod180(g.a0deg)).toBeCloseTo(0, 6)
      expect(mod180(g.a1deg)).toBeCloseTo(30, 6)
    }
  })

  it('lets a 90-degree X be dimensioned on all four sides', () => {
    // The X from the bug report: strokes top-left->bottom-right and
    // bottom-left->top-right. All four quadrants subtend 90, so the label must
    // be placeable up, down, left and right (previously only two were allowed).
    const A: [[number, number], [number, number]] = [[-1, 1], [1, -1]]
    const B: [[number, number], [number, number]] = [[-1, -1], [1, 1]]
    for (const deg of [0, 90, 180, 270]) {
      const g = computeAngleDimension(A[0], A[1], B[0], B[1], at(deg))
      expect(g.isInside).toBe(true)
      expect(Math.abs(g.arcSpan)).toBeCloseTo(90, 6)
    }
  })

  it('handles exactly parallel lines without producing NaN', () => {
    const g = computeAngleDimension([0, 0], [10, 0], [0, 5], [10, 5])
    expect(Number.isFinite(g.vx)).toBe(true)
    expect(Number.isFinite(g.vy)).toBe(true)
    expect(Number.isFinite(g.labelX)).toBe(true)
    expect(Number.isFinite(g.labelY)).toBe(true)
  })
})
