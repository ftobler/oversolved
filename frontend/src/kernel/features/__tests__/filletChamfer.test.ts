// Always-on tests for the fillet/chamfer leaf's OCC-free guard paths (phase 2f).
// The geometry + edge-resolution paths are gated in occ/edgeModifierReal.test.ts
// and filletChamferReal.test.ts; here we exercise only the validation branches
// that run before any OCC call.

import { describe, it, expect } from 'vitest'
import { Repository, makeAncestryQuery } from '../../query'
import {
  solveFillet,
  solveChamfer,
  resolveFilletEdges,
  registerExactEdge,
  resolveEdgesWithIndex,
  resolveEdgesByQuery,
  type EdgeIndex,
} from '../filletChamfer'
import type { DisposeScope } from '../../occ/disposeScope'
import type { HandleTable } from '../../occ/handleTable'
import type { OccHandle } from '../../occ/handleTable'
import type { OccModule, OccShape, OccSubShape } from '../../occ/occTypes'
import type { Body } from '../../types3d'

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

  it('rejects a NaN radius the same way as a non-positive radius', () => {
    expect(() =>
      solveFillet(oc, scope, table, { id: 'f', fillet: { edges: ['?b:edge:0'], radius: NaN } }, repo, oneBody()),
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

  it('an unknown viewport-form source_body throws the named error, never a TypeError', () => {
    // M21: a 'body:<id>' ref is invisible to resolveBodyIds, so the group key
    // used to stay the raw ref and indexFor dereferenced bodyStore[undefined]
    // into a TypeError. The resolver itself must reject it by name, before any
    // OCC call -- hence oc = null is fine here.
    expect(() =>
      solveFillet(oc, scope, table, {
        id: 'f', fillet: { edges: ['?b:edge:0'], radius: 2, source_body: 'body:body_nope' },
      }, repo, oneBody()),
    ).toThrow(/source body 'body:body_nope' not found/)
  })

  it('refuses a feature-form source_body that names more than one body', () => {
    // '@ex1' resolves to both siblings of a split feature. Grouping every edge
    // onto one of them silently would fillet the wrong body; the pick must name
    // exactly one.
    const store: Record<string, Body> = {
      body_ex1: { id: 'body_ex1', created_by: 'ex1', modified_by: [], shape: null, sketch_id: 'sk', brep_diff: null, profile_queries: [] },
      body_ex1_1: { id: 'body_ex1_1', created_by: 'ex1', modified_by: [], shape: null, sketch_id: 'sk', brep_diff: null, profile_queries: [] },
    }
    expect(() =>
      solveFillet(oc, scope, table, {
        id: 'f', fillet: { edges: ['?b:edge:0'], radius: 2, source_body: '@ex1' },
      }, repo, store),
    ).toThrow(/names 2 bodies/)
  })

  it('reports a source body that has no shape as no edges resolved', () => {
    // The picked body resolved but holds no shape; the group must resolve to
    // nothing and surface the named failure, not dereference null.
    expect(() =>
      solveFillet(oc, scope, table, {
        id: 'f', fillet: { edges: ['?b:edge:0'], radius: 2, source_body: 'body_b' },
      }, repo, oneBody()),
    ).toThrow(/fillet: no edges resolved/)
  })

  it('treats a null OCC shape as no edges resolved', () => {
    const nullShape = { get: () => ({ IsNull: () => true }) } as unknown as HandleTable
    const store: Record<string, Body> = { body_b: { ...oneBody().body_b, shape: 1 as never } }
    expect(() =>
      solveFillet(oc, scope, nullShape, {
        id: 'f', fillet: { edges: ['?b:edge:0'], radius: 2, source_body: 'body_b' },
      }, repo, store),
    ).toThrow(/fillet: no edges resolved/)
  })

  it('treats a shape whose IsNull probe throws as no edges resolved', () => {
    const throwing = {
      get: () => ({
        IsNull: () => {
          throw new Error('shape probe unavailable')
        },
      }),
    } as unknown as HandleTable
    const store: Record<string, Body> = { body_b: { ...oneBody().body_b, shape: 1 as never } }
    expect(() =>
      solveChamfer(oc, scope, throwing, {
        id: 'c', chamfer: { edges: ['?b:edge:0'], distance: 2, source_body: 'body_b' },
      }, repo, store),
    ).toThrow(/chamfer: no edges resolved/)
  })
})

describe('solveChamfer guard paths', () => {
  it('rejects a non-positive distance', () => {
    expect(() =>
      solveChamfer(oc, scope, table, { id: 'c', chamfer: { edges: ['?b:edge:0'], distance: -1 } }, repo, oneBody()),
    ).toThrow(/distance must be positive/)
  })

  it('rejects a NaN distance the same way as a non-positive distance', () => {
    expect(() =>
      solveChamfer(oc, scope, table, { id: 'c', chamfer: { edges: ['?b:edge:0'], distance: NaN } }, repo, oneBody()),
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

/**
 * resolveEdgesByQuery is the provenance-preserving sibling of
 * resolveEdgesWithIndex: a query that matches nothing must come back as an
 * empty list under its own key (so the caller can report it unresolved) instead
 * of vanishing into the flat result, and a matched query must resolve to the
 * same edges the flat resolver returns.
 */
describe('resolveEdgesByQuery provenance', () => {
  const scopeNull = null as unknown as DisposeScope
  const fakeEdge = (): OccShape => {
    const self = { IsSame: (o: OccSubShape) => o === (self as unknown as OccSubShape) }
    return self as unknown as OccShape
  }

  const emptyIndex = (): EdgeIndex => ({
    queryToEdge: new Map<string, OccShape>(),
    ambiguousQueries: new Set<string>(),
    ancestryRepo: new Repository(),
  })

  it('an unmatched query comes back with an empty list under its own key', () => {
    const index = emptyIndex()
    const q = makeAncestryQuery(['@ex1', '@body_b'], 'straightedge')
    const byQuery = resolveEdgesByQuery(oc, scopeNull, table, oneBody().body_b, index, [q])
    expect(byQuery.has(q)).toBe(true)
    expect(byQuery.get(q)).toEqual([])
  })

  it('a matched query resolves to the same edges as resolveEdgesWithIndex', () => {
    const index = emptyIndex()
    const q = makeAncestryQuery(['@ex1', '@body_b'], 'straightedge')
    const edge = fakeEdge()
    registerExactEdge(index.queryToEdge, index.ambiguousQueries, q, edge)

    const byQuery = resolveEdgesByQuery(oc, scopeNull, table, oneBody().body_b, index, [q])
    const flat = resolveEdgesWithIndex(oc, scopeNull, table, oneBody().body_b, index, [q])
    expect(byQuery.get(q)).toEqual([edge])
    expect(flat).toEqual([edge])
  })

  it('mixed matched and unmatched queries keep both under their own keys', () => {
    const index = emptyIndex()
    const qGood = makeAncestryQuery(['@ex1', '@body_b'], 'straightedge')
    const qBad = makeAncestryQuery(['@ex9', '@body_b'], 'straightedge')
    const edge = fakeEdge()
    registerExactEdge(index.queryToEdge, index.ambiguousQueries, qGood, edge)

    const byQuery = resolveEdgesByQuery(oc, scopeNull, table, oneBody().body_b, index, [qGood, qBad])
    expect(byQuery.get(qGood)).toEqual([edge])
    expect(byQuery.get(qBad)).toEqual([])
  })

  it('the same edge under two queries still dedups in the flat result', () => {
    const index = emptyIndex()
    const qA = makeAncestryQuery(['@ex1', '@body_b'], 'straightedge')
    const qB = makeAncestryQuery(['@ex2', '@body_b'], 'straightedge')
    const edge = fakeEdge()
    registerExactEdge(index.queryToEdge, index.ambiguousQueries, qA, edge)
    registerExactEdge(index.queryToEdge, index.ambiguousQueries, qB, edge)

    const byQuery = resolveEdgesByQuery(oc, scopeNull, table, oneBody().body_b, index, [qA, qB])
    const flat = resolveEdgesWithIndex(oc, scopeNull, table, oneBody().body_b, index, [qA, qB])
    expect(byQuery.get(qA)).toEqual([edge])
    expect(byQuery.get(qB)).toEqual([edge])
    expect(flat).toEqual([edge])
  })

  it('a face query on a body with no shape resolves to no edges instead of crashing', () => {
    // A face query falls through to the face->edges resolver, which needs the
    // body's OCC shape; a shape-less body must come back empty.
    const index = emptyIndex()
    const faceQuery = makeAncestryQuery(['@body_b'], 'flatface')
    const byQuery = resolveEdgesByQuery(oc, scopeNull, table, oneBody().body_b, index, [faceQuery])
    expect(byQuery.get(faceQuery)).toEqual([])
  })
})
