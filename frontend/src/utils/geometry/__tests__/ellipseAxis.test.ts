import { describe, it, expect } from 'vitest'
import { ellipseAxisDrag, ellipseAxisPoints, isEllipseAxisKey, ELLIPSE_AXIS_KEYS } from '@/utils/geometry/ellipseAxis'

// The axis handles are drawn (EntityLines) and pickable (buildSketchVertices) but
// are derived from center/a/b/theta rather than stored params, so before this
// existed a drag on one silently no-opped: VERTEX_INDICES['ellipse'] only maps
// 'center'. These pin the inversion that makes them draggable.

const applied = (params: number[], key: typeof ELLIPSE_AXIS_KEYS[number], to: [number, number]) => {
  const next = ellipseAxisDrag(params, key, to)
  if (!next) return null
  return [params[0], params[1], next.a, next.b, next.theta]
}

describe('isEllipseAxisKey', () => {
  it('accepts the 4 axis keys and rejects the others', () => {
    for (const k of ELLIPSE_AXIS_KEYS) expect(isEllipseAxisKey(k)).toBe(true)
    for (const k of ['center', 'start', 'end', 'xy', 'c1']) expect(isEllipseAxisKey(k)).toBe(false)
  })
})

describe('ellipseAxisDrag', () => {
  it('major1 lands exactly under the cursor (round-trip through ellipseAxisPoints)', () => {
    const next = applied([1, 2, 10, 5, 0], 'major1', [1, 14])!
    const ap = ellipseAxisPoints(next[0], next[1], next[2], next[3], next[4])
    expect(ap.major1[0]).toBeCloseTo(1)
    expect(ap.major1[1]).toBeCloseTo(14)
  })

  it('major1 both resizes and rotates, leaving the minor radius alone', () => {
    // Cursor straight above the center: a = 12, theta = 90deg.
    const next = applied([0, 0, 10, 5, 0], 'major1', [0, 12])!
    expect(next[2]).toBeCloseTo(12)  // a
    expect(next[3]).toBeCloseTo(5)   // b untouched
    expect(next[4]).toBeCloseTo(90)  // theta
  })

  it('major2 points the axis the opposite way', () => {
    const next = applied([0, 0, 10, 5, 0], 'major2', [0, 12])!
    const ap = ellipseAxisPoints(next[0], next[1], next[2], next[3], next[4])
    expect(next[2]).toBeCloseTo(12)
    expect(ap.major2[0]).toBeCloseTo(0)
    expect(ap.major2[1]).toBeCloseTo(12)
  })

  it('keeps theta on the warm-start branch across the atan2 seam', () => {
    // Warm start near 180deg; a cursor just past the seam must not spin to -180.
    const next = applied([0, 0, 10, 5, 179], 'major1', [-10, -0.5])!
    expect(next[4]).toBeGreaterThan(90)
    expect(next[4]).toBeCloseTo(182.86, 1)
  })

  it('minor1 resizes only, sliding along the fixed minor axis', () => {
    // theta=0 -> minor direction is +y. The cursor's x component is projected away,
    // so the ellipse must not rotate and a must not change.
    const next = applied([0, 0, 10, 5, 0], 'minor1', [7, 9])!
    expect(next[2]).toBeCloseTo(10)  // a untouched
    expect(next[3]).toBeCloseTo(9)   // b = the on-axis component only
    expect(next[4]).toBeCloseTo(0)   // theta untouched
  })

  it('minor2 gives the same radius as minor1 mirrored through the center', () => {
    const a = applied([0, 0, 10, 5, 0], 'minor1', [0, 9])!
    const b = applied([0, 0, 10, 5, 0], 'minor2', [0, -9])!
    expect(b[3]).toBeCloseTo(a[3])
  })

  it('respects a rotated frame when projecting a minor drag', () => {
    // theta=90 -> minor direction is -x, so only the x component counts.
    const next = applied([0, 0, 10, 5, 90], 'minor1', [-4, 100])!
    expect(next[3]).toBeCloseTo(4)
    expect(next[4]).toBeCloseTo(90)
  })

  it('clamps a collapsed minor axis instead of returning zero', () => {
    const next = applied([0, 0, 10, 5, 0], 'minor1', [3, 0])!
    expect(next[3]).toBeGreaterThan(0)
  })

  it('returns null when a major handle is dropped on the center', () => {
    expect(ellipseAxisDrag([0, 0, 10, 5, 0], 'major1', [0, 0])).toBeNull()
  })
})
