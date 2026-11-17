import { describe, it, expect } from 'vitest'
import type { Sketch } from '@/types/cad'
import { sketchPrimitive, type SketchFrame } from '@/utils/measure/adapters/sketch'
import { measureSelection } from '@/utils/measure/measureSelection'
import { measureOne } from '@/utils/measure/rules'

const FRONT: SketchFrame = {
  origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1],
}

const circleSketch = (radius: number): Sketch => ({ c1: { center: [0, 0], radius } })

describe('sketchPrimitive: the sketch named by the feature id (defect 3)', () => {
  // Seeded ids repeat between sketches: both sketches own a `c1`. The old
  // flattened map kept whichever sketch was assigned last, so a pick could read
  // a different sketch's circle.
  const solveResults = {
    sk1: { solved: circleSketch(1), plane: FRONT },
    sk2: { solved: circleSketch(4), plane: FRONT },
  }

  it('reads the pick own sketch, not the last sketch flattened under the same id', () => {
    expect(measureSelection(new Set(['entity:sk1:c1']), { solveResults }))
      .toEqual(['diameter 2.000 mm'])
    expect(measureSelection(new Set(['entity:sk2:c1']), { solveResults }))
      .toEqual(['diameter 8.000 mm'])
  })

  it('does not fall back to the flat sketch when the named sketch lacks the entity', () => {
    const flat: Sketch = { c1: { center: [0, 0], radius: 9 } }
    const result = sketchPrimitive({ featureId: 'sk2', eid: 'missing' }, flat, solveResults)
    expect(result).toBeNull()
  })

  it('uses the flat sketch when the named feature has no solve result', () => {
    // Sketch-edit callers and unit fixtures narrow the flat map to one sketch;
    // the per-feature solve result wins whenever there is one.
    const flat = circleSketch(3)
    expect(sketchPrimitive({ featureId: 'S1', eid: 'c1' }, flat, undefined))
      .toMatchObject({ type: 'circle', radius: 3 })
  })
})

describe('sketchPrimitive: the solved frame lifts local geometry to world (defect 2)', () => {
  // The shipped Top plane: local x is world x, local y is world -z.
  const TOP: SketchFrame = {
    origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 0, -1], normal: [0, 1, 0],
  }

  it('lifts a Top sketch line into world coordinates', () => {
    const line = sketchPrimitive(
      { featureId: 'sk1', eid: 'l1' },
      undefined,
      { sk1: { solved: { l1: { start: [0, 0], end: [40, 30] } }, plane: TOP } },
    )
    expect(line).toEqual({
      type: 'line',
      p0: [0, 0, 0],
      p1: [40, 0, -30],
      dir: [0.8, 0, -0.6],
      bounded: true,
    })
  })

  it('measures a sketch point on an offset plane against the plane it is offset from', () => {
    const OFFSET: SketchFrame = {
      origin: [0, 0, 7], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1],
    }
    const solveResults = {
      sk3: { solved: { p1: { x: 2, y: 3 } }, plane: OFFSET },
      builtin_plane_top: { plane: FRONT },
    }
    // The old rule dotted the sketch-local [2, 3, 0] against the world plane and
    // read 0; the point is on the z=7 plane, so the offset is 7.
    expect(measureSelection(new Set(['vertex:sk3:p1', '@builtin_plane_top']), { solveResults }))
      .toEqual(['distance 7.000 mm'])
  })

  it('gives a sketch arc its frame normal as the circle axis', () => {
    const arc = sketchPrimitive(
      { featureId: 'sk1', eid: 'a1' },
      undefined,
      {
        sk1: {
          solved: { a1: { center: [0, 0], radius: 2, angle_start: 0, angle_end: 90, start: [2, 0], end: [0, 2] } },
          plane: TOP,
        },
      },
    )
    expect(arc).toMatchObject({ type: 'circle', axis: [0, 1, 0], radius: 2 })
    expect(measureOne(arc!)).toMatchObject({ kind: 'radius', value: 2, label: 'radius' })
  })
})

describe('sketchPrimitive: vertices resolve through geomPoint', () => {
  const flat: Sketch = {
    SP1: { p1: [0, 0], p2: [1, 1], p3: [2, 1], p4: [3, 0] },
    E1: { center: [0, 0], a: 4, b: 2, theta: 0 },
    L1: { start: [0, 0], end: [3, 4] },
  }

  it('resolves a spline control point', () => {
    expect(sketchPrimitive({ featureId: 'S1', eid: 'SP1', sub: 'c1' }, flat, undefined))
      .toEqual({ type: 'point', p: [1, 1, 0] })
  })

  it('resolves an ellipse axis handle', () => {
    expect(sketchPrimitive({ featureId: 'S1', eid: 'E1', sub: 'major1' }, flat, undefined))
      .toEqual({ type: 'point', p: [4, 0, 0] })
  })

  it('resolves a line endpoint', () => {
    expect(sketchPrimitive({ featureId: 'S1', eid: 'L1', sub: 'end' }, flat, undefined))
      .toEqual({ type: 'point', p: [3, 4, 0] })
  })
})
