// Unit tests for the `vertex` select kind: the pick resolves through the vertex
// lineage (the kernel's `vertex_queries` array), and every position predicate is
// tested on the vertex's own point, because a vertex has no extent. Pure TS over
// synthetic solve results, like select.center.test.ts.

import { describe, it, expect } from 'vitest'
import { selectByPredicate, validateSelector, SelectorError } from '@/kernel/select'
import type { Selector } from '@/kernel/select'
import { makeAncestryQuery } from '@/kernel/query'
import type { BodyResult } from '@/types/cad'

type V3 = [number, number, number]

/** A box's eight corners: x in {0,10}, y in {0,6}, z in {0,4}. */
const CORNERS: V3[] = [
  [0, 0, 0], [10, 0, 0], [10, 6, 0], [0, 6, 0],
  [0, 0, 4], [10, 0, 4], [10, 6, 4], [0, 6, 4],
]

function vertexBody(id: string, points: V3[], queries: string[]): BodyResult {
  return {
    id,
    created_by: 'ex1',
    modified_by: [],
    edges: [],
    edge_queries: [],
    vertices: points,
    vertex_queries: queries,
    mesh: { vertices: [], faces: [], face_data: [], face_queries: [] },
  }
}

function box(): Record<string, BodyResult> {
  return { body_p: vertexBody('body_p', CORNERS, CORNERS.map((_, i) => `vq${i}`)) }
}

function queriesOf(selector: Selector, bodies: Record<string, BodyResult>): string[] {
  return selectByPredicate(selector, bodies).queries
}

describe('selectByPredicate: vertex kind', () => {
  it('names every vertex of the body, in index order', () => {
    const out = selectByPredicate({ kind: 'vertex' }, box())
    expect(out.queries).toEqual(CORNERS.map((_, i) => `vq${i}`))
    for (const item of out.items) {
      expect(item.kind).toBe('vertex')
      expect(item.geometry).toMatchObject({ kind: 'vertex' })
    }
  })

  it('reports the vertex position as the geometry summary', () => {
    const items = selectByPredicate({ kind: 'vertex' }, box()).items
    expect(items.map(item => item.geometry)).toEqual(CORNERS.map(point => ({ kind: 'vertex', point })))
    expect(items[5].body).toBe('body_p')
    expect(items[5].index).toBe(5)
  })

  it('skips a vertex with no query, the way the edge and face kinds do', () => {
    const bodies = { body_p: vertexBody('body_p', CORNERS, ['vq0', '', 'vq2']) }
    expect(queriesOf({ kind: 'vertex' }, bodies)).toEqual(['vq0', 'vq2'])
  })

  it('orders by body id, not object insertion', () => {
    const bodies = {
      body_z: vertexBody('body_z', [[1, 1, 1]], ['z0']),
      body_a: vertexBody('body_a', [[2, 2, 2]], ['a0']),
    }
    expect(queriesOf({ kind: 'vertex' }, bodies)).toEqual(['a0', 'z0'])
  })

  it('honors `from`', () => {
    const bodies = {
      body_a: vertexBody('body_a', [[1, 1, 1]], ['a0']),
      body_b: vertexBody('body_b', [[2, 2, 2]], ['b0']),
    }
    expect(queriesOf({ kind: 'vertex', from: 'body_b' }, bodies)).toEqual(['b0'])
  })
})

describe('selectByPredicate: vertex position predicates', () => {
  it('extreme groups the corners sharing the extreme coordinate', () => {
    // The four corners of the y = 6 face.
    expect(queriesOf({ kind: 'vertex', where: { extreme: { axis: [0, 1, 0], side: 'max' } } }, box()))
      .toEqual(['vq2', 'vq3', 'vq6', 'vq7'])
  })

  it('two extremes name the one corner CadQuery\'s "<XY" names', () => {
    // faces(">Z").vertices("<XY"): the x-min and y-min corner of the top face.
    const corner = selectByPredicate({
      kind: 'vertex',
      where: {
        and: [
          { extreme: { axis: [0, 0, 1], side: 'max' } },
          { extreme: { axis: [1, 0, 0], side: 'min' } },
          { extreme: { axis: [0, 1, 0], side: 'min' } },
        ],
      },
    }, box())
    expect(corner.items).toHaveLength(1)
    expect(corner.items[0].geometry).toMatchObject({ kind: 'vertex', point: [0, 0, 4] })
  })

  it('center at a point names the vertex standing there, within the measure floor', () => {
    expect(queriesOf({ kind: 'vertex', where: { center: { point: [10, 6, 4] } } }, box()))
      .toEqual(['vq6'])
    // The same point authored with f64 noise is still the corner.
    expect(queriesOf({ kind: 'vertex', where: { center: { point: [10, 6, 4 - 1e-9] } } }, box()))
      .toEqual(['vq6'])
    // A named radius adds the same absolute floor `within` adds.
    expect(queriesOf({ kind: 'vertex', where: { center: { point: [10, 6, 4], radius: 0.5 } } }, box()))
      .toEqual(['vq6'])
    expect(() => queriesOf({ kind: 'vertex', where: { center: { point: [5, 3, 2] } } }, box()))
      .toThrow(SelectorError)
  })

  it('center on one axis coordinate names the corners sharing it', () => {
    expect(queriesOf({ kind: 'vertex', where: { center: { axis: 'z', at: 4 } } }, box()))
      .toEqual(['vq4', 'vq5', 'vq6', 'vq7'])
    expect(queriesOf({ kind: 'vertex', where: { center: { axis: 'x', min: 5 } } }, box()))
      .toEqual(['vq1', 'vq2', 'vq5', 'vq6'])
  })

  it('within tests the point, so a vertex on the boundary is inside', () => {
    expect(queriesOf({ kind: 'vertex', where: { within: { axis: 'z', min: 4 } } }, box()))
      .toEqual(['vq4', 'vq5', 'vq6', 'vq7'])
    expect(queriesOf({ kind: 'vertex', where: { and: [
      { within: { axis: 'x', min: 0, max: 0 } },
      { within: { axis: 'y', min: 0, max: 0 } },
    ] } }, box())).toEqual(['vq0', 'vq4'])
  })

  it('type "vertex" matches, and it is the whole vocabulary', () => {
    expect(queriesOf({ kind: 'vertex', where: { type: 'vertex' } }, box())).toHaveLength(8)
    expect(() => queriesOf({ kind: 'vertex', where: { type: 'corner' } }, box())).toThrow(SelectorError)
  })

  it('created_by reads the vertex ancestry query', () => {
    const query = makeAncestryQuery(['@ex1', '@body_p'], 'vertex')
    const bodies = { body_p: vertexBody('body_p', [[1, 2, 3]], [query]) }
    expect(queriesOf({ kind: 'vertex', where: { created_by: 'ex1' } }, bodies)).toEqual([query])
    expect(() => queriesOf({ kind: 'vertex', where: { created_by: 'nope' } }, bodies))
      .toThrow(SelectorError)
  })

  it('a vertex has no direction and no radius, so those predicates name nothing', () => {
    expect(() => queriesOf({ kind: 'vertex', where: { parallel: [0, 0, 1] } }, box()))
      .toThrow(/matched no vertices/)
    expect(() => queriesOf({ kind: 'vertex', where: { perpendicular: [0, 0, 1] } }, box()))
      .toThrow(/matched no vertices/)
    expect(() => queriesOf({ kind: 'vertex', where: { radius: 1 } }, box()))
      .toThrow(/matched no vertices/)
  })

  it('the empty-match diagnosis names the candidate count and the clause', () => {
    try {
      queriesOf({ kind: 'vertex', where: { center: { axis: 'z', at: 99 } } }, box())
      throw new Error('unreachable: the selector must throw')
    } catch (e) {
      expect((e as Error).message).toContain('selector matched no vertices (8 candidates')
      expect((e as Error).message).toContain('center {"axis":"z","at":99} matched 0')
    }
  })

  it('on_face stays a face-to-edge aid and refuses a vertex inner selector', () => {
    expect(() => queriesOf({
      kind: 'edge',
      where: { on_face: { kind: 'vertex' } },
    }, box())).toThrow(/on_face needs a face selector/)
  })
})

describe('validateSelector: vertex kind', () => {
  it('accepts kind "vertex" and its predicates', () => {
    expect(validateSelector({ kind: 'vertex' })).toMatchObject({ kind: 'vertex' })
    expect(validateSelector({ kind: 'vertex', where: { center: { point: [0, 0, 0] } } }))
      .toMatchObject({ where: { center: { point: [0, 0, 0] } } })
    expect(validateSelector({ kind: 'vertex', where: { extreme: { axis: 'x', side: 'max' } } }))
      .toMatchObject({ where: { extreme: { axis: [1, 0, 0], side: 'max' } } })
  })

  it('refuses an unknown kind by naming the three kinds', () => {
    expect(() => validateSelector({ kind: 'vert' })).toThrow(/kind must be "edge", "face" or "vertex"/)
  })

  it('refuses a type name outside the vertex vocabulary', () => {
    expect(() => validateSelector({ kind: 'vertex', where: { type: 'corner' } }))
      .toThrow(/type "corner" is not a valid vertex type/)
    expect(() => validateSelector({ kind: 'vertex', where: { type: 'flatface' } }))
      .toThrow(/is not a valid vertex type/)
    expect(() => validateSelector({ kind: 'vertex', where: { and: [{ type: 'vertex' }, { type: 'line' }] } }))
      .toThrow(/is not a valid vertex type/)
  })

  it('refuses a face-only predicate shape the same way it does for edges', () => {
    expect(() => validateSelector({ kind: 'vertex', where: { bogus: 1 } }))
      .toThrow(/has unknown predicate "bogus"/)
  })
})
