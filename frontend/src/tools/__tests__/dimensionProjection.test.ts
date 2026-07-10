import { describe, it, expect } from 'vitest'
import type { Sketch } from '@/types/cad'
import {
  projectedKindForEdge,
  findProjectionOf,
  planBrepDimensionPick,
  refreshProjectedPickKinds,
} from '@/tools/dimensionProjection'

const EDGE_Q = '?body:b1/edge:3'
const VERTEX_Q = '?body:b1/vertex:7'

const plan = (over: Partial<Parameters<typeof planBrepDimensionPick>[0]> = {}) =>
  planBrepDimensionPick({
    query: EDGE_Q,
    featureId: 'S1',
    sketch: null,
    isVertexPick: false,
    sourceKind: 'line',
    newEntityId: () => 'NEW',
    ...over,
  })

describe('projectedKindForEdge', () => {
  it('passes through the curve kinds a projection can lower to', () => {
    expect(projectedKindForEdge('circle')).toBe('circle')
    expect(projectedKindForEdge('arc')).toBe('arc')
    expect(projectedKindForEdge('ellipse')).toBe('ellipse')
    expect(projectedKindForEdge('spline')).toBe('spline')
  })

  it('falls back to a line for an unknown or missing kind', () => {
    expect(projectedKindForEdge('line')).toBe('line')
    expect(projectedKindForEdge(null)).toBe('line')
    expect(projectedKindForEdge(undefined)).toBe('line')
    expect(projectedKindForEdge('bspline_surface_curve')).toBe('line')
  })
})

describe('findProjectionOf', () => {
  const sketch = {
    P1: { start: [0, 0], end: [1, 0], projected: true, source: EDGE_Q },
    L2: { start: [0, 0], end: [1, 1] },
  } as unknown as Sketch

  it('finds the entity projected from the query', () => {
    expect(findProjectionOf(sketch, EDGE_Q)).toBe('P1')
  })

  it('returns null for an unprojected source or an absent sketch', () => {
    expect(findProjectionOf(sketch, '?body:b1/edge:99')).toBeNull()
    expect(findProjectionOf(null, EDGE_Q)).toBeNull()
  })
})

describe('planBrepDimensionPick', () => {
  it('projects a body edge and dimensions the projection', () => {
    const { mutations, pick } = plan()
    expect(mutations).toEqual([
      { type: 'add_projected_entity', featureId: 'S1', kind: 'line', source: EDGE_Q, entityId: 'NEW' },
    ])
    expect(pick).toEqual({ isVertex: false, target: 'entity:S1:NEW', entityKind: 'line', source: EDGE_Q })
  })

  it('carries the edge curve kind into the projection and the pick', () => {
    const { mutations, pick } = plan({ sourceKind: 'circle' })
    expect(mutations[0]).toMatchObject({ kind: 'circle' })
    expect(pick.entityKind).toBe('circle')
  })

  it('projects a body vertex as a point and dimensions its xy vertex', () => {
    const { mutations, pick } = plan({ query: VERTEX_Q, isVertexPick: true, sourceKind: null })
    expect(mutations[0]).toMatchObject({ kind: 'point', source: VERTEX_Q })
    expect(pick).toEqual({ isVertex: true, target: 'vertex:S1:NEW:xy', entityKind: null, source: VERTEX_Q })
  })

  it('reuses an existing projection of the same edge instead of duplicating it', () => {
    const sketch = {
      P1: { start: [0, 0], end: [1, 0], projected: true, source: EDGE_Q },
    } as unknown as Sketch
    const { mutations, pick } = plan({ sketch })
    expect(mutations).toEqual([])
    expect(pick).toMatchObject({ isVertex: false, target: 'entity:S1:P1', entityKind: 'line' })
  })

  it('takes the solved kind when reusing a projection the lowerer promoted', () => {
    // A tilted body circle was declared 'circle' but lowered to an ellipse.
    const sketch = {
      P1: { center: [0, 0], a: 2, b: 1, theta: 0, projected: true, source: EDGE_Q },
    } as unknown as Sketch
    const { pick } = plan({ sketch, sourceKind: 'circle' })
    expect(pick.entityKind).toBe('ellipse')
  })

  it('reuses an existing projected point through its vertex target', () => {
    const sketch = {
      P1: { x: 1, y: 2, projected: true, source: VERTEX_Q },
    } as unknown as Sketch
    const { mutations, pick } = plan({ query: VERTEX_Q, isVertexPick: true, sketch })
    expect(mutations).toEqual([])
    expect(pick).toMatchObject({ isVertex: true, target: 'vertex:S1:P1:xy', entityKind: null })
  })

  it('reuses a projection made earlier in the gesture, before its solve landed', () => {
    // Picking the same edge twice is the same-entity path to a length dim: the
    // second pick must name the first pick's entity, not a fresh projection.
    const first = plan()
    const second = plan({ picks: [first.pick], newEntityId: () => 'OTHER' })
    expect(second.mutations).toEqual([])
    expect(second.pick.target).toBe(first.pick.target)
  })

  it('reuses a pending projected point through its vertex target', () => {
    const first = plan({ query: VERTEX_Q, isVertexPick: true })
    const second = plan({ query: VERTEX_Q, isVertexPick: true, picks: [first.pick], newEntityId: () => 'OTHER' })
    expect(second.mutations).toEqual([])
    expect(second.pick).toEqual(first.pick)
  })

  it('projects a different body element even while another pick is pending', () => {
    const first = plan()
    const second = plan({ query: '?body:b1/edge:4', picks: [first.pick], newEntityId: () => 'OTHER' })
    expect(second.mutations).toHaveLength(1)
    expect(second.pick.target).toBe('entity:S1:OTHER')
  })
})

describe('refreshProjectedPickKinds', () => {
  const sketch = {
    P1: { center: [0, 0], a: 2, b: 1, theta: 0, projected: true, source: EDGE_Q },
    L2: { start: [0, 0], end: [1, 1] },
  } as unknown as Sketch

  it('replaces a stale projected kind with the solved one', () => {
    const picks = [{ isVertex: false, target: 'entity:S1:P1', entityKind: 'circle' }]
    expect(refreshProjectedPickKinds(picks, sketch, 'S1')).toEqual([
      { isVertex: false, target: 'entity:S1:P1', entityKind: 'ellipse' },
    ])
  })

  it('leaves non-projected, vertex, foreign-feature and unsolved picks alone', () => {
    const picks = [
      { isVertex: false, target: 'entity:S1:L2', entityKind: 'line' },
      { isVertex: true, target: 'vertex:S1:L2:start', entityKind: null },
      { isVertex: false, target: 'entity:S9:P1', entityKind: 'circle' },
      { isVertex: false, target: 'entity:S1:GONE', entityKind: 'circle' },
    ]
    expect(refreshProjectedPickKinds(picks, sketch, 'S1')).toEqual(picks)
  })

  it('is a no-op without a solved sketch', () => {
    const picks = [{ isVertex: false, target: 'entity:S1:P1', entityKind: 'circle' }]
    expect(refreshProjectedPickKinds(picks, null, 'S1')).toBe(picks)
  })
})
