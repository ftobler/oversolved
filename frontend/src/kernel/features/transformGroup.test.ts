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

  it('circular_array: missing source body pick raises even when a body is available', () => {
    /** No source_body pick must be a solve error, not a silent auto-pick of
     *  the first body in the store. */
    expect(() =>
      solveCircularArray(oc, scope, table, { id: 'c', circular_array: {} }, repo, { body_s: nullBody('body_s') }),
    ).toThrow(/source body is required/)
  })

  it('array: missing source body pick raises even when a body is available', () => {
    expect(() =>
      solveArray(oc, scope, table, { id: 'a', array: {} }, repo, { body_s: nullBody('body_s') }),
    ).toThrow(/source body is required/)
  })

  it('array: count_x=0 with include_source=false raises', () => {
    /** count_x=0 with include_source=false produces no instances -- can
     *  only be tested with real OCC; guard path verifies error surfaces. */
    const store = { body_s: { ...nullBody('body_s'), shape: 1 as never } }
    expect(() =>
      solveArray(oc, scope, table, {
        id: 'a', array: { source_body: 'body_s', mode: 'linear', count_x: 0, include_source: false },
      }, repo, store),
    ).toThrow()
  })

  it('circular_array: count=0 raises', () => {
    /** count=0 should produce an error (division by zero in step_angle). */
    const store = { body_s: { ...nullBody('body_s'), shape: 1 as never } }
    expect(() =>
      solveCircularArray(oc, scope, table, {
        id: 'c', circular_array: { source_body: 'body_s', count: 0 },
      }, repo, store),
    ).toThrow()
  })

  it('circular_array: missing source body with available IDs in message', () => {
    /** Non-existent source_body reports available body IDs. */
    expect(() =>
      solveCircularArray(oc, scope, table, {
        id: 'c', circular_array: { source_body: 'nonexistent' },
      }, repo, { body_real: nullBody('body_real') }),
    ).toThrow(/source body 'nonexistent' not found/)
    try {
      solveCircularArray(oc, scope, table, {
        id: 'c', circular_array: { source_body: 'nonexistent' },
      }, repo, { body_real: nullBody('body_real') })
    } catch (e) {
      expect((e as Error).message).toMatch(/available body IDs/)
    }
  })

  it('array: missing source body with available IDs in message', () => {
    /** Non-existent source_body reports available body IDs. */
    expect(() =>
      solveArray(oc, scope, table, {
        id: 'a', array: { source_body: 'nonexistent' },
      }, repo, { body_real: nullBody('body_real') }),
    ).toThrow(/source body 'nonexistent' not found/)
    try {
      solveArray(oc, scope, table, {
        id: 'a', array: { source_body: 'nonexistent' },
      }, repo, { body_real: nullBody('body_real') })
    } catch (e) {
      expect((e as Error).message).toMatch(/available body IDs/)
    }
  })
})

describe('transform / mirror guard paths', () => {
  it('transform: body not found', () => {
    expect(() =>
      solveTransform(oc, scope, table, { id: 't', transform: { bodies: ['nope'] } }, repo, { body_s: nullBody('body_s') }),
    ).toThrow(/body not found/)
  })

  it('transform: rotation_angle without an axis', () => {
    expect(() =>
      solveTransform(oc, scope, table, { id: 't', transform: { bodies: ['body_s'], rotation_angle: 90 } }, repo, {
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
