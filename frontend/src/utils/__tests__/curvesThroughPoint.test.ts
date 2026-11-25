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

describe('curvesThroughPoint conic and Bezier loci', () => {
  // A straight cubic Bezier from (0,0) to (10,0): with both controls on the
  // chord B(t) stays on the x axis, crossing the vertical line x=5 at (5,0).
  const straight: Sketch = {
    sp: { p1: [0, 0], p2: [10 / 3, 0], p3: [20 / 3, 0], p4: [10, 0] } as Sketch[string],
    ln: { start: [5, -10], end: [5, 10] } as Sketch[string],
  }

  it('attributes a spline and a line at their crossing', () => {
    expect(curvesThroughPoint(straight, [5, 0], 1e-6).sort()).toEqual(['ln', 'sp'])
  })

  it('keeps the line but drops the spline for a point off the spline locus', () => {
    // (5,1) is on the vertical line, one unit above the Bezier.
    expect(curvesThroughPoint(straight, [5, 1], 1e-6)).toEqual(['ln'])
  })

  it('drops the spline past its end', () => {
    // The spline stops at x=10; a second horizontal line runs through (11,0)
    // so the result isolates the spline's refusal beyond its end.
    const sketch: Sketch = {
      sp: straight.sp,
      axis: { start: [0, 0], end: [20, 0] } as Sketch[string],
    }
    expect(curvesThroughPoint(sketch, [11, 0], 1e-6)).toEqual(['axis'])
  })

  it('attributes a fit spline and a line at their crossing', () => {
    const sketch: Sketch = {
      fit: { points: [[0, 0], [10, 0]] } as Sketch[string],
      ln: { start: [5, -10], end: [5, 10] } as Sketch[string],
    }
    expect(curvesThroughPoint(sketch, [5, 0], 1e-6).sort()).toEqual(['fit', 'ln'])
    expect(curvesThroughPoint(sketch, [5, 1], 1e-6)).toEqual(['ln'])
  })

  it('treats a degenerate fit spline as no curve without throwing', () => {
    // Coincident fit points are refused by interpolation; membership must treat
    // that the same way fitSplinePolyline falls back to no curve.
    const sketch: Sketch = { bad: { points: [[2, 2], [2, 2]] } as Sketch[string] }
    expect(curvesThroughPoint(sketch, [2, 2], 1e-6)).toEqual([])
  })

  it('attributes a rotated ellipse only at a point on its locus', () => {
    const sketch: Sketch = {
      ell: { center: [0, 0], a: 5, b: 3, theta: 30 } as Sketch[string],
    }
    // Rotate the major vertex (u=5, v=0) into world coordinates.
    const on: [number, number] = [5 * Math.cos(Math.PI / 6), 5 * Math.sin(Math.PI / 6)]
    expect(curvesThroughPoint(sketch, on, 1e-6)).toEqual(['ell'])
    expect(curvesThroughPoint(sketch, [0, 0], 1e-6)).toEqual([])  // centre is inside
  })
})
