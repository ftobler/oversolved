// The shared operand planner: a non-sketch pick (the document origin, or a
// B-rep vertex/edge) becomes a projection in the active sketch plus the target
// ref the constraint or dimension should name. A source already projected is
// reused, so picking it twice never stacks duplicates.
import { describe, it, expect } from 'vitest'
import type { Sketch } from '@/types/cad'
import { planProjectedOperand } from '@/tools/operandProjection'

const ORIGIN = '@builtin_origin'
const EDGE_Q = '?body:b1/edge:3'
const VERTEX_Q = '?body:b1/vertex:7'

const plan = (over: Partial<Parameters<typeof planProjectedOperand>[0]> = {}) =>
  planProjectedOperand({
    query: ORIGIN,
    featureId: 'S1',
    sketch: null,
    isVertexPick: true,
    sourceKind: null,
    newEntityId: () => 'NEW',
    ...over,
  })

describe('planProjectedOperand', () => {
  it('projects the origin as a point and targets its xy vertex', () => {
    const { mutations, target, kind, isVertex } = plan()
    expect(mutations).toEqual([
      { type: 'add_projected_entity', featureId: 'S1', kind: 'point', source: ORIGIN, entityId: 'NEW' },
    ])
    expect(target).toBe('vertex:S1:NEW:xy')
    expect(kind).toBe('point')
    expect(isVertex).toBe(true)
  })

  it('reuses a projection planned earlier in the same act', () => {
    const first = plan()
    const second = plan({ pending: [first] })
    expect(second.mutations).toEqual([])
    expect(second.target).toBe(first.target)
  })

  it('reuses an origin already projected in the solved sketch', () => {
    const sketch = {
      P1: { x: 0, y: 0, projected: true, source: ORIGIN },
    } as unknown as Sketch
    const { mutations, target } = plan({ sketch })
    expect(mutations).toEqual([])
    expect(target).toBe('vertex:S1:P1:xy')
  })

  it('reuses a recorded projection whose entity has not solved yet', () => {
    // The constraint can land before the next solve: reuse it without throwing
    // on the missing entity, and fall back to the declared point kind.
    const { mutations, target, kind } = plan({
      sketch: {},
      projections: [{ id: 'proj_P1', kind: 'projection', target: '$P1', source: ORIGIN }],
    })
    expect(mutations).toEqual([])
    expect(target).toBe('vertex:S1:P1:xy')
    expect(kind).toBe('point')
  })

  it('declares a B-rep edge projection with the edge curve kind', () => {
    const { mutations, target, kind, isVertex } = plan({
      query: EDGE_Q, isVertexPick: false, sourceKind: 'circle',
    })
    expect(mutations).toEqual([
      { type: 'add_projected_entity', featureId: 'S1', kind: 'circle', source: EDGE_Q, entityId: 'NEW' },
    ])
    expect(target).toBe('entity:S1:NEW')
    expect(kind).toBe('circle')
    expect(isVertex).toBe(false)
  })

  it('projects a B-rep vertex as a point and targets its xy vertex', () => {
    const { mutations, target, isVertex } = plan({
      query: VERTEX_Q, isVertexPick: true, sourceKind: null,
    })
    expect(mutations[0]).toMatchObject({ kind: 'point', source: VERTEX_Q })
    expect(target).toBe('vertex:S1:NEW:xy')
    expect(isVertex).toBe(true)
  })
})
