// Always-on tests for the transform-group leaves' OCC-free guard paths (phase 2f).
// The geometry paths are gated in transformGroupReal.test.ts.

import { describe, it, expect } from 'vitest'
import { Repository } from '../../query'
import { solveArray, solveCircularArray } from '../array'
import { solveTransform, solveMirror } from '../transformMirror'
import type { HandleTable } from '../../occ/handleTable'
import type { OccModule } from '../../occ/occTypes'
import type { Body } from '../../types3d'

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
    const store = { body_s: { ...nullBody('body_s'), shape: 1 as never } }
    expect(() =>
      solveArray(oc, scope, table, {
        id: 'a', array: { source_body: 'body_s', mode: 'linear', count_x: 0, include_source: false },
      }, repo, store),
    ).toThrow(/count_x must be a positive integer/)
  })

  it('circular_array: count=0 raises', () => {
    // count=0 would divide by zero in step_angle; it must be refused by name.
    const store = { body_s: { ...nullBody('body_s'), shape: 1 as never } }
    expect(() =>
      solveCircularArray(oc, scope, table, {
        id: 'c', circular_array: { source_body: 'body_s', count: 0 },
      }, repo, store),
    ).toThrow(/count must be a positive integer/)
  })

  it('circular_array: missing source body with available IDs in message', () => {
    // Non-existent source_body reports available body IDs.
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
    // Non-existent source_body reports available body IDs.
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

  it('transform: a query resolving to a body the store no longer holds', () => {
    // The `?` branch of resolveBodyRefKeys reads the id off the REPO (a face
    // record's `body_id`), which can name a body a later feature deleted. That
    // key is not a live store key, and reading `.shape` off the missing entry
    // used to throw a bare TypeError out of the middle of the solve.
    const staleRepo = { query: () => ({ body_id: 'gone' }) } as unknown as Repository
    expect(() =>
      solveTransform(oc, scope, table, { id: 't', transform: { bodies: ['?1;@ex1:flatface'] } }, staleRepo, {
        body_s: nullBody('body_s'),
      }),
    ).toThrow(/body no longer exists: "gone"/)
  })

  it('transform: rotation_angle without an axis', () => {
    expect(() =>
      solveTransform(oc, scope, table, { id: 't', transform: { bodies: ['body_s'], rotation_angle: 90 } }, repo, {
        body_s: { ...nullBody('body_s'), shape: 1 as never },
      }),
    ).toThrow(/no rotation axis specified/)
  })

  it('transform: a non-finite rotation_angle fails loud instead of silently vanishing', () => {
    // NaN is falsy: the old truthy checks let it skip BOTH the missing-axis
    // error and the rotation itself. The guard must fire with or without an
    // axis present.
    expect(() =>
      solveTransform(oc, scope, table, { id: 't', transform: { bodies: ['body_s'], rotation_angle: NaN } }, repo, {
        body_s: { ...nullBody('body_s'), shape: 1 as never },
      }),
    ).toThrow(/rotation_angle must be a finite number/)
    expect(() =>
      solveTransform(oc, scope, table, {
        id: 't',
        transform: { bodies: ['body_s'], rotation_angle: Infinity, rotation_axis_origin: [0, 0, 0], rotation_axis_direction: [0, 0, 1] },
      }, repo, {
        body_s: { ...nullBody('body_s'), shape: 1 as never },
      }),
    ).toThrow(/rotation_angle must be a finite number/)
  })

  it('transform: a non-finite scale fails before reaching the kernel', () => {
    // NaN passes the `scale !== 1.0` gate and used to reach makeScaleTrsf.
    for (const bad of [NaN, Infinity]) {
      expect(() =>
        solveTransform(oc, scope, table, { id: 't', transform: { bodies: ['body_s'], scale: bad } }, repo, {
          body_s: { ...nullBody('body_s'), shape: 1 as never },
        }),
      ).toThrow(/scale must be a finite number/)
    }
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

  it('transform: a translation_from pick that resolves to nothing fails before the kernel', () => {
    // Both point refs are resolved up front; a dangling one must not be
    // silently dropped (which would translate by the other point alone).
    const repo = new Repository()
    expect(() =>
      solveTransform(oc, scope, table, {
        id: 't',
        transform: { bodies: ['body_s'], translation_from: '@missing', translation_to: '@p1' },
      }, repo, { body_s: { ...nullBody('body_s'), shape: 1 as never } }),
    ).toThrow(/translation_from not found/)
  })

  it('transform: a translation_to pick that resolves to nothing fails before the kernel', () => {
    const repo = new Repository()
    repo.register('from', { origin: [1, 1, 1] })
    expect(() =>
      solveTransform(oc, scope, table, {
        id: 't',
        transform: { bodies: ['body_s'], translation_from: '@from', translation_to: '@missing' },
      }, repo, { body_s: { ...nullBody('body_s'), shape: 1 as never } }),
    ).toThrow(/translation_to not found/)
  })

  it('transform: a rotation_axis pick that resolves to nothing fails before the kernel', () => {
    const repo = new Repository()
    expect(() =>
      solveTransform(oc, scope, table, {
        id: 't',
        transform: { bodies: ['body_s'], rotation_axis: '@missing' },
      }, repo, { body_s: { ...nullBody('body_s'), shape: 1 as never } }),
    ).toThrow(/rotation_axis not found/)
  })

  it('transform: a scale_center_from pick that resolves to nothing fails before the kernel', () => {
    const repo = new Repository()
    expect(() =>
      solveTransform(oc, scope, table, {
        id: 't',
        transform: { bodies: ['body_s'], scale: 2, scale_center_from: '@missing' },
      }, repo, { body_s: { ...nullBody('body_s'), shape: 1 as never } }),
    ).toThrow(/scale_center_from not found/)
  })

  it('mirror: a plane query that resolves to nothing names the ref', () => {
    const repo = new Repository()
    expect(() =>
      solveMirror(oc, scope, table, { id: 'm', mirror: { body: 'body_s', plane: '@missing' } }, repo, {
        body_s: { ...nullBody('body_s'), shape: 1 as never },
      }),
    ).toThrow(/plane not found: "@missing"/)
  })

  it('mirror: a plane query that resolves to a non-plane payload is refused, not guessed', () => {
    // A stale pick can resolve to some other registry entry; treating its
    // origin/normal as a plane would mirror across a made-up frame.
    const repo = new Repository()
    repo.register('notaplane', { type: 'weird' })
    expect(() =>
      solveMirror(oc, scope, table, { id: 'm', mirror: { body: 'body_s', plane: '@notaplane' } }, repo, {
        body_s: { ...nullBody('body_s'), shape: 1 as never },
      }),
    ).toThrow(/did not resolve to a plane/)
  })
})
