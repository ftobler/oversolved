import { describe, it, expect } from 'vitest'
import { geomPoint } from '@/utils/geometry/geometryMapping'
import type { Sketch, Ellipse } from '@/types/cad'

describe('geomPoint for ellipse', () => {
  const sketch: Sketch = {
    e1: { center: [3, 7], a: 4, b: 2, theta: 30 } as Ellipse,
  }

  it('resolves an ellipse reference to its center', () => {
    expect(geomPoint(sketch, { entity: 'e1' })).toEqual([3, 7])
  })

  it('resolves the center regardless of the point selector', () => {
    expect(geomPoint(sketch, { entity: 'e1', point: 'center' })).toEqual([3, 7])
  })

  it('returns a fresh array, not a reference into the entity', () => {
    const pt = geomPoint(sketch, { entity: 'e1' })!
    pt[0] = 999
    expect((sketch.e1 as Ellipse).center[0]).toBe(3)  // entity unchanged
  })

  it('returns null for a missing entity', () => {
    expect(geomPoint(sketch, { entity: 'nope' })).toBeNull()
  })
})
