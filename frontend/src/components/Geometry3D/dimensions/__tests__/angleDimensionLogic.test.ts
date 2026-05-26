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

  it('marks the label outside when dragged off the wedge for a small angle', () => {
    const A: [[number, number], [number, number]] = [[0, 5], [20, 3.9518444143]]
    const B: [[number, number], [number, number]] = [[0, 0], [20, 0]]
    // Vertex is near (95,0); offset places the label well off the 3-degree wedge.
    const g = computeAngleDimension(A[0], A[1], B[0], B[1], [-40, 30])
    expect(g.isInside).toBe(false)
  })

  it('always renders the theta-wedge, never its supplement, for any label direction', () => {
    // 30-degree angle: lines along 0 and 30 degrees from the origin.
    const A: [[number, number], [number, number]] = [[0, 0], [10, 0]]
    const B: [[number, number], [number, number]] = [[0, 0], [Math.cos(Math.PI / 6) * 10, Math.sin(Math.PI / 6) * 10]]
    // Sweep the label all the way around; the wedge magnitude must stay ~30,
    // never flip to the 150-degree supplement.
    for (let deg = 0; deg < 360; deg += 15) {
      const r = 5
      const pos: [number, number] = [r * Math.cos((deg * Math.PI) / 180), r * Math.sin((deg * Math.PI) / 180)]
      const g = computeAngleDimension(A[0], A[1], B[0], B[1], pos)
      expect(Math.abs(g.arcSpan)).toBeCloseTo(30, 6)
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
