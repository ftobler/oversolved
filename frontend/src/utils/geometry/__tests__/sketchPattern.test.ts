// The pure rigid-copy math behind pattern_entities: entity blocks under a
// translation or rotation, the instance generator of each mode with its
// refusals, and the orientation rules a carried constraint follows.

import { describe, it, expect } from 'vitest'
import {
  instanceTransforms, transformEntityParams, transformVertexKey, transformPoint,
  rotatedAxisKind, rotatedAxisDistance, rotatedConstraintAxis, transformFixedOverride,
  MAX_PATTERN_INSTANCES, type SketchTransform, type SketchPatternFields,
} from '../sketchPattern'
import { canonicalVertexPositions } from '../mirrorSketch'

const rot = (angleDeg: number, cx = 0, cy = 0): SketchTransform => ({ angleDeg, cx, cy, tx: 0, ty: 0 })
const move = (tx: number, ty: number): SketchTransform => ({ angleDeg: 0, cx: 0, cy: 0, tx, ty })

const closeTo = (actual: readonly number[] | null, expected: readonly number[]) => {
  expect(actual).not.toBeNull()
  expect(actual!).toHaveLength(expected.length)
  actual!.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 6))
}

const transformsOf = (fields: SketchPatternFields, crossSketch = false): SketchTransform[] => {
  const built = instanceTransforms(fields, { crossSketch })
  if ('reason' in built) throw new Error(built.reason)
  return built.transforms
}

const reasonOf = (fields: SketchPatternFields, crossSketch = false): string => {
  const built = instanceTransforms(fields, { crossSketch })
  return 'reason' in built ? built.reason : ''
}

describe('transformEntityParams', () => {
  it('turns a line by 90 about the origin exactly', () => {
    expect(transformEntityParams('line', [0, 0, 10, 0], rot(90))).toEqual([0, 0, 0, 10])
  })

  it('turns an arc centre and both angles, keeping the CCW sweep', () => {
    expect(transformEntityParams('arc', [5, 5, 2, 0, 90], rot(90))).toEqual([-5, 5, 2, 90, 180])
    // a0 normalizes into [0, 360) and a1 keeps a0 + span, a full circle too.
    expect(transformEntityParams('arc', [0, 0, 1, 300, 420], rot(90))).toEqual([0, 0, 1, 30, 150])
    expect(transformEntityParams('arc', [0, 0, 1, 0, 360], rot(45))).toEqual([0, 0, 1, 45, 405])
  })

  it('keeps sizes and moves every position pair', () => {
    expect(transformEntityParams('circle', [1, 2, 3], move(4, 5))).toEqual([5, 7, 3])
    expect(transformEntityParams('point', [1, 2], move(-1, -2))).toEqual([0, 0])
    closeTo(transformEntityParams('ellipse', [1, 0, 3, 1, 10], rot(30)), [Math.cos(Math.PI / 6), 0.5, 3, 1, 40])
    expect(transformEntityParams('spline', [0, 0, 1, 1, 2, 1, 3, 0], move(1, 2))).toEqual([1, 2, 2, 3, 3, 3, 4, 2])
    // Three fit points plus both end handles: every pair is a position.
    expect(transformEntityParams('fit_spline', [0, 0, 10, 0, 20, 5, 1, 1, 19, 6], move(1, 2), 'both'))
      .toEqual([1, 2, 11, 2, 21, 7, 2, 3, 20, 8])
  })

  it('refuses an unknown kind, a malformed block and non-finite input', () => {
    expect(transformEntityParams('text', [0, 0], move(1, 0))).toBeNull()
    expect(transformEntityParams('line', [0, 0, 1], move(1, 0))).toBeNull()
    expect(transformEntityParams('line', [0, 0, 1, Number.NaN], move(1, 0))).toBeNull()
    expect(transformEntityParams('fit_spline', [0, 0, 10, 0], move(1, 0), 'both')).toBeNull()
  })

  it('keeps every vertex key on the image of the same vertex (identity key map)', () => {
    const t: SketchTransform = { angleDeg: 37, cx: 2, cy: -1, tx: 3, ty: 4 }
    const cases: [string, number[], ('start' | 'end' | 'both')?][] = [
      ['line', [0, 0, 10, 3]],
      ['point', [4, 5]],
      ['circle', [1, 1, 2]],
      ['arc', [5, 5, 2, 20, 130]],
      ['ellipse', [1, 2, 4, 1.5, 25]],
      ['spline', [0, 0, 1, 2, 3, 2, 4, 0]],
      ['fit_spline', [0, 0, 5, 3, 10, 0, 1, 1, 9, 1], 'both'],
    ]
    for (const [kind, params, handles] of cases) {
      const image = transformEntityParams(kind, params, t, handles)!
      const before = canonicalVertexPositions(kind, params, handles)!
      const after = canonicalVertexPositions(kind, image, handles)!
      for (const [key, pos] of Object.entries(before)) {
        const mapped = transformVertexKey(kind, key)
        expect(mapped).toBe(key)
        const want = transformPoint(pos, t)
        expect(after[mapped][0]).toBeCloseTo(want[0], 5)
        expect(after[mapped][1]).toBeCloseTo(want[1], 5)
      }
    }
  })
})

describe('instanceTransforms', () => {
  it('linear steps by the pitch along the normalized direction', () => {
    const ts = transformsOf({ mode: 'linear', count: 4, pitch: 10 })
    expect(ts.map(t => [t.tx, t.ty])).toEqual([[10, 0], [20, 0], [30, 0]])
    const up = transformsOf({ mode: 'linear', count: 2, pitch: 5, direction: [0, 2] })
    expect(up.map(t => [t.tx, t.ty])).toEqual([[0, 5]])
    // A negative pitch walks the other way.
    expect(transformsOf({ mode: 'linear', count: 2, pitch: -3 }).map(t => t.tx)).toEqual([-3])
  })

  it('grid fills count x count2 minus the source, column fastest', () => {
    const ts = transformsOf({ mode: 'grid', count: 3, count2: 2, pitch: 5, pitch2: 7 })
    expect(ts.map(t => [t.tx, t.ty])).toEqual([[5, 0], [10, 0], [0, 7], [5, 7], [10, 7]])
  })

  it('rotate steps the angle about the centre', () => {
    const ts = transformsOf({ mode: 'rotate', count: 3, angle_deg: 90, center: [1, 1] })
    expect(ts.map(t => t.angleDeg)).toEqual([90, 180])
    expect(transformPoint([2, 1], ts[0])).toEqual([1, 2])
    // The default centre is the sketch origin.
    expect(transformPoint([1, 0], transformsOf({ mode: 'rotate', count: 2, angle_deg: 90 })[0])).toEqual([0, 1])
  })

  it('copy rotates first and translates second', () => {
    const [t] = transformsOf({ mode: 'copy', angle_deg: 30, translate: [5, 0] })
    const p = transformPoint([1, 0], t)
    expect(p[0]).toBeCloseTo(5 + Math.cos(Math.PI / 6), 12)
    expect(p[1]).toBeCloseTo(0.5, 12)
  })

  it('refuses zero steps, zero vectors, stacked and identity copies by name', () => {
    expect(reasonOf({ mode: 'linear', count: 3, pitch: 0 })).toContain('pitch must not be zero')
    expect(reasonOf({ mode: 'linear', count: 3, pitch: 1, direction: [0, 0] })).toContain('direction must not be a zero vector')
    expect(reasonOf({ mode: 'rotate', count: 5, angle_deg: 90 })).toContain('instance 4 lands on an earlier instance')
    expect(reasonOf({ mode: 'rotate', count: 2, angle_deg: 0 })).toContain('angle_deg must not be zero')
    // A decimal step whose 7th copy lands at 359.999997 deg is stacked on the
    // source to well inside the loop-closure tolerance.
    expect(reasonOf({ mode: 'rotate', count: 8, angle_deg: 51.428571 })).toContain('instance 7 lands on an earlier instance')
    expect(transformsOf({ mode: 'rotate', count: 7, angle_deg: 51.428571 })).toHaveLength(6)
    // An untyped mode that names an Object.prototype member is refused, not thrown.
    expect(reasonOf({ mode: 'constructor', count: 2 } as unknown as SketchPatternFields)).toContain('mode must be one of')
    expect(reasonOf({ mode: 'grid', count: 2, count2: 2, pitch: 1, pitch2: 1, direction2: [2, 0] }))
      .toContain('direction2 is parallel to direction')
    expect(reasonOf({ mode: 'copy' })).toContain('identity')
    expect(reasonOf({ mode: 'copy', angle_deg: 360 })).toContain('identity')
    // Into another sketch the identity copy is a real copy.
    expect(transformsOf({ mode: 'copy' }, true)).toHaveLength(1)
  })

  it('refuses counts that are not whole, under two or over the cap', () => {
    expect(reasonOf({ mode: 'linear', count: 1, pitch: 1 })).toContain('needs count >= 2')
    expect(reasonOf({ mode: 'linear', count: 2.5, pitch: 1 })).toContain('count must be a whole number')
    expect(reasonOf({ mode: 'linear', count: 0, pitch: 1 })).toContain('count must be a whole number')
    expect(reasonOf({ mode: 'linear', count: 201, pitch: 1 })).toBe(`count 201 is above the cap of ${MAX_PATTERN_INSTANCES} instances`)
    expect(reasonOf({ mode: 'grid', count: 15, count2: 14, pitch: 1, pitch2: 1 })).toContain('count 210 is above the cap')
    expect(transformsOf({ mode: 'linear', count: 200, pitch: 1 })).toHaveLength(199)
  })
})

describe('orientation rules for carried constraints', () => {
  it('horizontal/vertical keep at half turns, swap at quarter turns, drop otherwise', () => {
    expect(rotatedAxisKind('horizontal', 0)).toBe('horizontal')
    expect(rotatedAxisKind('horizontal', 180)).toBe('horizontal')
    expect(rotatedAxisKind('horizontal', 90)).toBe('vertical')
    expect(rotatedAxisKind('vertical', -90)).toBe('horizontal')
    expect(rotatedAxisKind('horizontal', 30)).toBeNull()
  })

  it('point_distance_x/y follow the coordinate the measured difference lands on', () => {
    // a = (0, 0), b = (3, 1): dx = 3 (x, sign +1) and dy = 1 (y, sign +1).
    for (const angle of [0, 90, 180, 270]) {
      const b = transformPoint([3, 1], rot(angle))
      const a = transformPoint([0, 0], rot(angle))
      const diff = { point_distance_x: b[0] - a[0], point_distance_y: b[1] - a[1] }
      const x = rotatedAxisDistance('point_distance_x', 1, angle)!
      expect(diff[x.kind]).toBeCloseTo(x.sign! * 3, 9)
      const y = rotatedAxisDistance('point_distance_y', 1, angle)!
      expect(diff[y.kind]).toBeCloseTo(y.sign! * 1, 9)
    }
    expect(rotatedAxisDistance('point_distance_x', undefined, 90)).toEqual({ kind: 'point_distance_y', sign: undefined })
    expect(rotatedAxisDistance('point_distance_x', 1, 45)).toBeNull()
  })

  it('a midpoint axis swaps at a quarter turn and both is invariant', () => {
    expect(rotatedConstraintAxis('x', 90)).toBe('y')
    expect(rotatedConstraintAxis('y', 180)).toBe('y')
    expect(rotatedConstraintAxis('x', 10)).toBeNull()
    expect(rotatedConstraintAxis('both', 10)).toBe('both')
    expect(rotatedConstraintAxis(undefined, 10)).toBeUndefined()
  })

  it('fixed moves as a point, and a one-coordinate pin swaps or drops', () => {
    expect(transformFixedOverride(1, 2, move(3, 4))).toEqual({ x: 4, y: 6 })
    const t90: SketchTransform = { angleDeg: 90, cx: 0, cy: 0, tx: 10, ty: 0 }
    // x = 3 turned by 90 about the origin is y = 3, then moved by (10, 0).
    expect(transformFixedOverride(3, undefined, t90)).toEqual({ y: 3 })
    // y = 2 turned by 90 is x = -2, then moved to x = 8.
    expect(transformFixedOverride(undefined, 2, t90)).toEqual({ x: 8 })
    expect(transformFixedOverride(3, undefined, rot(180, 1, 0))).toEqual({ x: -1 })
    expect(transformFixedOverride(3, undefined, rot(30))).toBeNull()
    expect(transformFixedOverride(undefined, undefined, rot(30))).toEqual({})
  })
})
