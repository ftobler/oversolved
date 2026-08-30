import { describe, it, expect } from 'vitest'
import { computeConstraintRender, deriveConstraints } from '@/utils/geometry/geometryMapping'
import type { Sketch, PartConstraint, PartFeature, SymbolRender } from '@/types/cad'

// A square drawn CCW from (0,0): four line entities forming a closed chain.
function squareSketch(): Sketch {
  return {
    l0: { start: [0, 0], end: [10, 0] },
    l1: { start: [10, 0], end: [10, 10] },
    l2: { start: [10, 10], end: [0, 10] },
    l3: { start: [0, 10], end: [0, 0] },
  } as Sketch
}

describe('computeConstraintRender  -  ngon sugar tile', () => {
  it('ngon renders a symbol tile at the polygon centroid', () => {
    const c: PartConstraint = { id: 'ng', kind: 'ngon', refs: ['$l0', '$l1', '$l2', '$l3'] }
    const r = computeConstraintRender(c, squareSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_ngon')
    // centroid of the four line START points: (0,0),(10,0),(10,10),(0,10) -> (5,5)
    expect(r.at).toEqual([5, 5])
    expect(r.entities).toEqual(['l0', 'l1', 'l2', 'l3'])
  })

  it('deriveConstraints includes the ngon tile (a symbol_, not dropped as unknown)', () => {
    const feature: PartFeature = {
      id: 'sk', kind: 'sketch',
      constraints: [{ id: 'ng', kind: 'ngon', refs: ['$l0', '$l1', '$l2', '$l3'] }],
    }
    const map = deriveConstraints(feature, squareSketch())
    expect(map['ng']).toBeTruthy()
    expect(map['ng'].render.kind).toBe('symbol_ngon')
  })
})
