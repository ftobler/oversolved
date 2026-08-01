// Always-on tests for the fillet/chamfer leaf's OCC-free guard paths (phase 2f).
// The geometry + edge-resolution paths are gated in occ/edgeModifierReal.test.ts
// and filletChamferReal.test.ts; here we exercise only the validation branches
// that run before any OCC call.

import { describe, it, expect } from 'vitest'
import { Repository, makeAncestryQuery } from '../query'
import {
  solveFillet,
  solveChamfer,
  resolveFilletEdges,
  pickFaceByDescriptor,
  registerExactEdge,
  resolveEdgesWithIndex,
  type EdgeIndex,
} from './filletChamfer'
import type { DisposeScope } from '../occ/disposeScope'
import type { HandleTable } from '../occ/handleTable'
import type { OccHandle } from '../occ/handleTable'
import type { OccModule, OccShape, OccSubShape } from '../occ/occTypes'
import type { Body } from '../types3d'
import type { GeomDescriptor } from '../geomDescriptor'

const oc = null as unknown as OccModule
const scope = null as never
const table = null as unknown as HandleTable
const repo = new Repository()

function oneBody(): Record<string, Body> {
  return {
    body_b: {
      id: 'body_b',
      created_by: 'ex1',
      modified_by: [],
      shape: null,
      sketch_id: 'sk',
      brep_diff: null,
      profile_queries: [],
    },
  }
}

describe('solveFillet guard paths', () => {
  it('rejects a non-positive radius', () => {
    expect(() =>
      solveFillet(oc, scope, table, { id: 'f', fillet: { edges: ['?b:edge:0'], radius: 0 } }, repo, oneBody()),
    ).toThrow(/radius must be positive/)
  })

  it('requires at least one edge', () => {
    expect(() =>
      solveFillet(oc, scope, table, { id: 'f', fillet: { edges: [], radius: 2 } }, repo, oneBody()),
    ).toThrow(/requires at least one edge/)
  })

  it('requires bodies in the store', () => {
    expect(() =>
      solveFillet(oc, scope, table, { id: 'f', fillet: { edges: ['?b:edge:0'], radius: 2 } }, repo, {}),
    ).toThrow(/no bodies in body_store/)
  })
})

describe('solveChamfer guard paths', () => {
  it('rejects a non-positive distance', () => {
    expect(() =>
      solveChamfer(oc, scope, table, { id: 'c', chamfer: { edges: ['?b:edge:0'], distance: -1 } }, repo, oneBody()),
    ).toThrow(/distance must be positive/)
  })

  it('requires at least one edge', () => {
    expect(() =>
      solveChamfer(oc, scope, table, { id: 'c', chamfer: { edges: [], distance: 2 } }, repo, oneBody()),
    ).toThrow(/requires at least one edge/)
  })
})

/** resolveFilletEdges must return [] when edgeQueries is empty. */
describe('resolveFilletEdges guard', () => {
  const scopeNull = null as unknown as DisposeScope

  it('returns empty array when edgeQueries is empty (body with valid shape)', () => {
    const body: Body = {
      id: 'b1',
      created_by: 'f1',
      modified_by: [],
      shape: 1 as OccHandle,  // non-null to exercise the edgeQueries.length === 0 branch
      sketch_id: 'sk',
      brep_diff: null,
      profile_queries: [],
    }
    expect(resolveFilletEdges(oc, scopeNull, table, body, [])).toEqual([])
  })

  it('returns empty array when edgeQueries is empty (body with null shape)', () => {
    expect(resolveFilletEdges(oc, scopeNull, table, oneBody().body_b, [])).toEqual([])
  })
})

/**
 * pickFaceByDescriptor: the @gdf| tier of resolveFaceToEdges. An ambiguous
 * match (near-tie, no clear nearest-with-margin winner) must refuse -- the
 * fillet/chamfer leaf cuts metal, so it returns undefined and the caller
 * emits no edges, rather than guessing and filleting the wrong face's edges.
 */
describe('pickFaceByDescriptor refusal', () => {
  const face = (point: number[], axis: number[]): GeomDescriptor => ({ kind: 'face', point, axis })

  it('near-tie outside the tight window -> undefined (no edges)', () => {
    const qd = face([0, 0, 10], [0, 0, 1])
    const candidates: Array<[string, GeomDescriptor]> = [
      ['capA', face([0, 0, 11], [0, 0, 1])],
      ['capB', face([0, 0, 11.5], [0, 0, 1])],
    ]
    expect(pickFaceByDescriptor(qd, candidates)).toBeUndefined()
  })

  it('two tight hits -> undefined (no edges)', () => {
    const qd = face([0, 0, 10], [0, 0, 1])
    const candidates: Array<[string, GeomDescriptor]> = [
      ['capA', face([0, 0, 10.0001], [0, 0, 1])],
      ['capB', face([0, 0, 9.9999], [0, 0, 1])],
    ]
    expect(pickFaceByDescriptor(qd, candidates)).toBeUndefined()
  })

  it('unique tight hit wins (the matching face gets filleted)', () => {
    const qd = face([0, 0, 10], [0, 0, 1])
    const candidates: Array<[string, GeomDescriptor]> = [
      ['cap', face([0, 0, 10.0002], [0, 0, 1])],
      ['other', face([0, 0, 14], [0, 0, 1])],
    ]
    expect(pickFaceByDescriptor(qd, candidates)).toBe('cap')
  })
})

/**
 * Exact-match tier fail-safe: when two distinct edges share one query string
 * (a non-unique query, e.g. edges lacking a construction @u| uuid), the tier
 * must refuse rather than last-wins onto an arbitrary edge. Filleting the wrong
 * edge is silent and fail-wrong, so an ambiguous exact hit stays unresolved,
 * mirroring resolveByStableAncestry's AmbiguousQueryError refusal. A query that
 * uniquely names one edge still resolves exactly (no regression).
 */
describe('exact-match edge tier ambiguity refusal', () => {
  const scopeNull = null as unknown as DisposeScope
  // Distinct fake OCC edges: IsSame is identity, all the resolver needs here.
  const fakeEdge = (): OccShape => {
    const self = { IsSame: (o: OccSubShape) => o === (self as unknown as OccSubShape) }
    return self as unknown as OccShape
  }

  const emptyIndex = (): EdgeIndex => ({
    queryToEdge: new Map<string, OccShape>(),
    ambiguousQueries: new Set<string>(),
    ancestryRepo: new Repository(),  // empty: the ancestry fallback resolves nothing
  })

  it('two distinct edges under one query -> refused (no edge returned)', () => {
    const index = emptyIndex()
    const q = makeAncestryQuery(['@ex1', '@body_b'], 'straightedge')
    const edgeA = fakeEdge()
    const edgeB = fakeEdge()
    registerExactEdge(index.queryToEdge, index.ambiguousQueries, q, edgeA)
    registerExactEdge(index.queryToEdge, index.ambiguousQueries, q, edgeB)

    expect(index.ambiguousQueries.has(q)).toBe(true)  // collision recorded, not last-wins
    const resolved = resolveEdgesWithIndex(oc, scopeNull, table, oneBody().body_b, index, [q])
    expect(resolved).toEqual([])  // refuses rather than picking edgeA or edgeB
  })

  it('the same edge registered twice under one query is not ambiguous', () => {
    const index = emptyIndex()
    const q = makeAncestryQuery(['@ex1', '@body_b'], 'straightedge')
    const edge = fakeEdge()
    registerExactEdge(index.queryToEdge, index.ambiguousQueries, q, edge)
    registerExactEdge(index.queryToEdge, index.ambiguousQueries, q, edge)  // IsSame -> no collision

    expect(index.ambiguousQueries.has(q)).toBe(false)
    const resolved = resolveEdgesWithIndex(oc, scopeNull, table, oneBody().body_b, index, [q])
    expect(resolved).toEqual([edge])
  })

  it('a uniquely-named query still resolves to its single edge (no regression)', () => {
    const index = emptyIndex()
    const q = makeAncestryQuery(['@ex1', '@body_b'], 'straightedge')
    const edge = fakeEdge()
    registerExactEdge(index.queryToEdge, index.ambiguousQueries, q, edge)

    const resolved = resolveEdgesWithIndex(oc, scopeNull, table, oneBody().body_b, index, [q])
    expect(resolved).toEqual([edge])
  })
})
