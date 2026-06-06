// Always-on tests for the fillet/chamfer leaf's OCC-free guard paths (phase 2f).
// The geometry + edge-resolution paths are gated in occ/edgeModifierReal.test.ts
// and filletChamferReal.test.ts; here we exercise only the validation branches
// that run before any OCC call.

import { describe, it, expect } from 'vitest'
import { Repository } from '../query'
import { solveFillet, solveChamfer, resolveFilletEdges } from './filletChamfer'
import type { DisposeScope } from '../occ/disposeScope'
import type { HandleTable } from '../occ/handleTable'
import type { OccHandle } from '../occ/handleTable'
import type { OccModule } from '../occ/occTypes'
import type { Body } from '../types3d'

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
      face_lineage: {},
      edge_lineage: {},
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
      shape: 1 as OccHandle, // non-null to exercise the edgeQueries.length === 0 branch
      sketch_id: 'sk',
      brep_diff: null,
      profile_queries: [],
      face_lineage: {},
      edge_lineage: {},
    }
    expect(resolveFilletEdges(oc, scopeNull, table, body, [])).toEqual([])
  })

  it('returns empty array when edgeQueries is empty (body with null shape)', () => {
    expect(resolveFilletEdges(oc, scopeNull, table, oneBody().body_b, [])).toEqual([])
  })
})
