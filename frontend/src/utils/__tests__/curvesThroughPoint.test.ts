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

  it('matches an arc on radius', () => {
    const sketch: Sketch = {
      arc1: { center: [0, 0], radius: 5, angle_start: 0, angle_end: 180, start: [5, 0], end: [-5, 0] },
    }
    expect(curvesThroughPoint(sketch, [0, 5], 1e-6)).toEqual(['arc1'])
  })
})
