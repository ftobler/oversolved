import { describe, it, expect } from 'vitest'
import type { Sketch, Topology, PartConstraint } from '@/types/cad'
import { sketchToIntersectionCandidates, inferredContactCandidates } from '@/components/Geometry3D/snapDetection'
import { reconcileMaterializedContacts, type TopologyDict } from '@/kernel/topologyDecorate'

const FEATURE = 'S1'

// A line through the x-axis crossing a circle centred at the origin: contacts at
// (5,0) and (-5,0). No constraint relates them -> a free intersection (no host).
const makeSketch = (): Sketch => ({
  ln:   { start: [-10, 0], end: [10, 0] } as Sketch[string],
  circ: { center: [0, 0], radius: 5 } as Sketch[string],
})
const topo = (pts: Record<string, { x: number; y: number }>): Topology => ({
  intersection_points: pts,
  vertices: {},
  edges: [],
  surfaces: [],
})

describe('sketchToIntersectionCandidates', () => {
  it('offers each crossing as an isect handle baking in the contributing curves', () => {
    const cands = sketchToIntersectionCandidates(makeSketch(), topo({ a: { x: 5, y: 0 }, b: { x: -5, y: 0 } }), FEATURE, 'active_sketch')
    expect(cands).toHaveLength(2)
    const c = cands.find(x => x.position[0] === 5)!
    expect(c.id).toMatch(/^isect:S1:5:0:/)
    expect(c.id).toContain('ln')
    expect(c.id).toContain('circ')
    expect(c.kind).toBe('vertex')
  })

  it('drops a crossing that does not lie on two curves (stale/degenerate point)', () => {
    // (0,9) lies on neither the line (y=0) nor the circle (r=5).
    expect(sketchToIntersectionCandidates(makeSketch(), topo({ a: { x: 0, y: 9 } }), FEATURE, 'active_sketch')).toHaveLength(0)
  })

  it('returns nothing without topology', () => {
    expect(sketchToIntersectionCandidates(makeSketch(), undefined, FEATURE, 'active_sketch')).toHaveLength(0)
  })
})

describe('reconcileMaterializedContacts (slice 4: topology leans on the materialized point)', () => {
  const dict = (pts: Record<string, { x: number; y: number }>): TopologyDict => ({
    intersection_points: pts, vertices: {}, edges: [], surfaces: [],
  })

  it('drops a crossing owned by a materialized point so it is no longer inferred', () => {
    const t = reconcileMaterializedContacts(dict({ a: { x: 5, y: 0 }, b: { x: -5, y: 0 } }), [[5, 0]])
    // (5,0) is now a real point's identity; only the un-materialized (-5,0) remains.
    expect(Object.values(t.intersection_points).map(p => p.x)).toEqual([-5])
  })

  it('is a no-op when no point coincides (or no points exist)', () => {
    const ip = { a: { x: 5, y: 0 } }
    expect(reconcileMaterializedContacts(dict(ip), []).intersection_points).toBe(ip)
    expect(reconcileMaterializedContacts(dict(ip), [[1, 1]]).intersection_points).toEqual(ip)
  })
})

describe('inferredContactCandidates (docks UNION intersections)', () => {
  it('combines dock contacts and free intersections', () => {
    // Two tangent circles (dock) plus a crossing line.
    const sketch: Sketch = {
      circA: { center: [0, 0], radius: 5 } as Sketch[string],
      circB: { center: [10, 0], radius: 5 } as Sketch[string],
      ln:    { start: [0, -10], end: [0, 10] } as Sketch[string],  // crosses circA at (0,5)/(0,-5)
    }
    const tangent: PartConstraint[] = [{ id: 'tan', kind: 'tangent', a: '$circA', b: '$circB' }]
    const cands = inferredContactCandidates(
      sketch, FEATURE, tangent,
      topo({ t: { x: 5, y: 0 }, x1: { x: 0, y: 5 }, x2: { x: 0, y: -5 } }),
      'active_sketch',
    )
    const docks = cands.filter(c => c.id.startsWith('dock:'))
    const isects = cands.filter(c => c.id.startsWith('isect:'))
    expect(docks).toHaveLength(1)
    expect(isects).toHaveLength(2)  // (0,5) and (0,-5); the (5,0) tangent point is the dock
  })

  it('drops an intersection coinciding with a dock so the contact is offered once', () => {
    const sketch: Sketch = {
      circA: { center: [0, 0], radius: 5 } as Sketch[string],
      circB: { center: [10, 0], radius: 5 } as Sketch[string],
    }
    const tangent: PartConstraint[] = [{ id: 'tan', kind: 'tangent', a: '$circA', b: '$circB' }]
    // Topology also reports the tangent foot as a (collapsed) crossing at (5,0).
    const cands = inferredContactCandidates(sketch, FEATURE, tangent, topo({ t: { x: 5, y: 0 } }), 'active_sketch')
    expect(cands.filter(c => c.id.startsWith('dock:'))).toHaveLength(1)
    expect(cands.filter(c => c.id.startsWith('isect:'))).toHaveLength(0)
  })
})
