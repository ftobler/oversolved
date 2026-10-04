import { describe, it, expect } from 'vitest'
import type { Sketch } from '@/types/cad'
import { curvesThroughPoint } from '@/utils/geometry/curvesThroughPoint'

describe('curvesThroughPoint', () => {
  it('returns both circles meeting at an external tangency', () => {
    const sketch: Sketch = {
      circA: { center: [0, 0], radius: 5 },
      circB: { center: [10, 0], radius: 5 },  // tangent to circA at (5, 0)
    }
    const ids = curvesThroughPoint(sketch, [5, 0], 1e-6)
    expect(ids.sort()).toEqual(['circA', 'circB'])
  })

  it('excludes a circle the point is off of', () => {
    const sketch: Sketch = {
      circA: { center: [0, 0], radius: 5 },
      circOff: { center: [10, 0], radius: 3 },  // does not reach (5, 0)
    }
    expect(curvesThroughPoint(sketch, [5, 0], 1e-6)).toEqual(['circA'])
  })

  it('matches a line by perpendicular distance and excludes an offset line', () => {
    const sketch: Sketch = {
      onX: { start: [-1, 0], end: [1, 0] },     // the x-axis passes through (5, 0)
      offX: { start: [-1, 1], end: [1, 1] },    // y = 1, misses (5, 0)
    }
    expect(curvesThroughPoint(sketch, [5, 0], 1e-6)).toEqual(['onX'])
  })

  it('matches an arc only within its swept span', () => {
    // Upper half-circle (0 deg -> 180 deg CCW): (0,5) is on the span, (0,-5) is on
    // the full-circle locus but off the arc and must NOT match.
    const arc: Sketch = {
      arc1: { center: [0, 0], radius: 5, angle_start: 0, angle_end: 180, start: [5, 0], end: [-5, 0] },
    }
    expect(curvesThroughPoint(arc, [0, 5], 1e-6)).toEqual(['arc1'])
    expect(curvesThroughPoint(arc, [0, -5], 1e-6)).toEqual([])
  })

  it('counts a contact sitting on an arc endpoint', () => {
    const arc: Sketch = {
      arc1: { center: [0, 0], radius: 5, angle_start: 0, angle_end: 180, start: [5, 0], end: [-5, 0] },
    }
    expect(curvesThroughPoint(arc, [5, 0], 1e-6)).toEqual(['arc1'])   // start
    expect(curvesThroughPoint(arc, [-5, 0], 1e-6)).toEqual(['arc1'])  // end
  })

  it('a full circle matches anywhere on its locus regardless of angle', () => {
    const circ: Sketch = { c: { center: [0, 0], radius: 5 } }
    expect(curvesThroughPoint(circ, [0, -5], 1e-6)).toEqual(['c'])
  })

  it('an arc with a 360-degree sweep matches a point on the far side', () => {
    // A full-circle arc written as 0 -> 360: the modulo would fold the 360 span
    // to 0 and drop a point at 270 degrees. It must count as the full sweep.
    const arc: Sketch = {
      arc1: { center: [0, 0], radius: 5, angle_start: 0, angle_end: 360, start: [5, 0], end: [5, 0] },
    }
    expect(curvesThroughPoint(arc, [0, -5], 1e-6)).toEqual(['arc1'])
    expect(curvesThroughPoint(arc, [-5, 0], 1e-6)).toEqual(['arc1'])
  })
})
