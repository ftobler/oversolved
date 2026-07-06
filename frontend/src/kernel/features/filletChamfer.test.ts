// Always-on tests for the fillet/chamfer leaf's OCC-free guard paths (phase 2f).
// The geometry + edge-resolution paths are gated in occ/edgeModifierReal.test.ts
// and filletChamferReal.test.ts; here we exercise only the validation branches
// that run before any OCC call.

import { describe, it, expect } from 'vitest'
import { Repository } from '../query'
import { solveFillet, solveChamfer, resolveFilletEdges, pickFaceByDescriptor } from './filletChamfer'
import type { DisposeScope } from '../occ/disposeScope'
import type { HandleTable } from '../occ/handleTable'
import type { OccHandle } from '../occ/handleTable'
import type { OccModule } from '../occ/occTypes'
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
