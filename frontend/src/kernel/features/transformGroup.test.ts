// Always-on tests for the transform-group leaves' OCC-free guard paths (phase 2f).
// The geometry paths are gated in transformGroupReal.test.ts.

import { describe, it, expect } from 'vitest'
import { Repository } from '../query'
import { solveArray, solveCircularArray } from './array'
import { solveTransform, solveMirror } from './transformMirror'
import type { HandleTable } from '../occ/handleTable'
import type { OccModule } from '../occ/occTypes'
import type { Body } from '../types3d'

const oc = null as unknown as OccModule
const scope = null as never
const table = null as unknown as HandleTable
const repo = new Repository()

function nullBody(id: string): Body {
  return {
    id,
    created_by: 'ex',
    modified_by: [],
    shape: null,
    sketch_id: 'sk',
    brep_diff: null,
    profile_queries: [],
    face_lineage: {},
    edge_lineage: {},
  }
}

describe('array / circular_array guard paths', () => {
  it('array: source body not found', () => {
    expect(() =>
      solveArray(oc, scope, table, { id: 'a', array: { source_body: 'nope' } }, repo, { body_s: nullBody('body_s') }),
    ).toThrow(/source body 'nope' not found/)
  })

  it('array: source body has no shape', () => {
    expect(() =>
      solveArray(oc, scope, table, { id: 'a', array: { source_body: 'body_s' } }, repo, { body_s: nullBody('body_s') }),
    ).toThrow(/source body has no shape/)
  })

  it('circular_array: no bodies', () => {
    expect(() =>
      solveCircularArray(oc, scope, table, { id: 'c', circular_array: {} }, repo, {}),
    ).toThrow(/no source body with shape found/)
  })
})

describe('transform / mirror guard paths', () => {
  it('transform: body not found', () => {
    expect(() =>
      solveTransform(oc, scope, table, { id: 't', transform: { body: 'nope' } }, repo, { body_s: nullBody('body_s') }),
    ).toThrow(/body not found/)
  })

  it('transform: rotation_angle without an axis', () => {
    expect(() =>
      solveTransform(oc, scope, table, { id: 't', transform: { body: 'body_s', rotation_angle: 90 } }, repo, {
        body_s: { ...nullBody('body_s'), shape: 1 as never },
      }),
    ).toThrow(/no rotation axis specified/)
  })

  it('mirror: plane is required', () => {
    expect(() =>
      solveMirror(oc, scope, table, { id: 'm', mirror: { body: 'body_s' } }, repo, {
        body_s: { ...nullBody('body_s'), shape: 1 as never },
      }),
    ).toThrow(/plane is required/)
  })

  it('mirror: body not found', () => {
    expect(() =>
      solveMirror(oc, scope, table, { id: 'm', mirror: { body: 'nope' } }, repo, { body_s: nullBody('body_s') }),
    ).toThrow(/body not found/)
  })
})
