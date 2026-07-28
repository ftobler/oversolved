// Always-on tests for the delete_body leaf (features/deleteBody.ts). delete_body
// is pure store logic + handle release, so it needs no OCC: a stub Disposable
// stands in for a body shape to verify the HandleTable handle is released.

import { describe, it, expect } from 'vitest'
import { Repository, makeAncestryQuery } from '../query'
import { HandleTable } from '../occ/handleTable'
import { solveDeleteBody } from './deleteBody'
import { resolveBodyIds } from './shared'
import type { OccModule } from '../occ/occTypes'
import type { Body } from '../types3d'

const oc = null as unknown as OccModule
const scope = null as never

function body(id: string): Body {
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

describe('solveDeleteBody', () => {
  it('removes the referenced body and releases its handle', () => {
    const table = new HandleTable({ finalizerGuard: false })
    let deleted = false
    const stub = { delete: () => { deleted = true } }
    const bodyStore: Record<string, Body> = { body_a: body('body_a'), body_b: body('body_b') }
    bodyStore.body_a.shape = table.register(stub, 'ex')

    const result = solveDeleteBody(oc, scope, table, { id: 'd', delete_body: { bodies: ['body_a'] } }, new Repository(), bodyStore)

    expect(result).toEqual({ status: 'ok', deleted_body_ids: ['body_a'] })
    expect(Object.keys(bodyStore)).toEqual(['body_b'])
    expect(deleted).toBe(true)
  })

  it('removes every listed body and releases each handle', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const deleted: string[] = []
    const bodyStore: Record<string, Body> = { body_a: body('body_a'), body_b: body('body_b'), body_c: body('body_c') }
    bodyStore.body_a.shape = table.register({ delete: () => { deleted.push('a') } }, 'ex')
    bodyStore.body_c.shape = table.register({ delete: () => { deleted.push('c') } }, 'ex')

    const result = solveDeleteBody(oc, scope, table, { id: 'd', delete_body: { bodies: ['body_a', 'body_c'] } }, new Repository(), bodyStore)

    expect(result).toEqual({ status: 'ok', deleted_body_ids: ['body_a', 'body_c'] })
    expect(Object.keys(bodyStore)).toEqual(['body_b'])
    expect(deleted).toEqual(['a', 'c'])
  })

  it('collapses two refs that name the same body', () => {
    const bodyStore: Record<string, Body> = { body_ex1: body('body_ex1'), body_b: body('body_b') }

    const result = solveDeleteBody(
      oc, scope, new HandleTable({ finalizerGuard: false }),
      { id: 'd', delete_body: { bodies: ['face:ex1:?4;@ex1:face', 'face:ex1:?7;@ex1:face'] } },
      new Repository(), bodyStore,
    )

    expect(result).toEqual({ status: 'ok', deleted_body_ids: ['body_ex1'] })
    expect(Object.keys(bodyStore)).toEqual(['body_b'])
  })

  it('deletes nothing when the list is empty', () => {
    const bodyStore: Record<string, Body> = { body_a: body('body_a') }
    const result = solveDeleteBody(oc, scope, new HandleTable({ finalizerGuard: false }), { id: 'd', delete_body: { bodies: [] } }, new Repository(), bodyStore)
    expect(result).toEqual({ status: 'ok', deleted_body_ids: [] })
    expect(Object.keys(bodyStore)).toEqual(['body_a'])
  })

  it('throws when the body ref does not resolve', () => {
    expect(() =>
      solveDeleteBody(oc, scope, new HandleTable({ finalizerGuard: false }), { id: 'd', delete_body: { bodies: ['nope'] } }, new Repository(), { body_b: body('body_b') }),
    ).toThrow()
  })

  it('leaves the store untouched when a later ref in the list is bad', () => {
    const bodyStore: Record<string, Body> = { body_a: body('body_a') }
    expect(() =>
      solveDeleteBody(oc, scope, new HandleTable({ finalizerGuard: false }), { id: 'd', delete_body: { bodies: ['body_a', 'nope'] } }, new Repository(), bodyStore),
    ).toThrow()
    expect(Object.keys(bodyStore)).toEqual(['body_a'])
  })

  it('a feature ref deletes every body that feature made, siblings included', () => {
    // A feature owns each solid its result split into (features/bodySplit.ts).
    // Resolving '@ex1' to the first sibling alone deleted one half of a severed
    // part and reported status ok, leaving the rest of it standing.
    const table = new HandleTable({ finalizerGuard: false })
    const bodyStore: Record<string, Body> = {
      body_ex1: body('body_ex1'), body_ex1_1: body('body_ex1_1'), body_other: body('body_other'),
    }
    bodyStore.body_ex1.created_by = 'ex1'
    bodyStore.body_ex1_1.created_by = 'ex1'
    bodyStore.body_other.created_by = 'ex2'

    const result = solveDeleteBody(oc, scope, table, { id: 'd', delete_body: { bodies: ['@ex1'] } }, new Repository(), bodyStore)

    expect(result.deleted_body_ids).toEqual(['body_ex1', 'body_ex1_1'])
    expect(Object.keys(bodyStore)).toEqual(['body_other'])
  })

  it('a topo-fallback face ref deletes the body that face sits on', () => {
    // What a face pick writes when the kernel minted no named query for it
    // (utils/query/selectionId.ts topoFallbackQuery). Nothing understood the
    // form, so the pick resolved to nothing and the whole solve failed.
    const bodyStore: Record<string, Body> = { body_ex1: body('body_ex1'), body_b: body('body_b') }

    const result = solveDeleteBody(
      oc, scope, new HandleTable({ finalizerGuard: false }),
      { id: 'd', delete_body: { bodies: ['@body_ex1/face/0'] } }, new Repository(), bodyStore,
    )

    expect(result.deleted_body_ids).toEqual(['body_ex1'])
    expect(Object.keys(bodyStore)).toEqual(['body_b'])
  })

  it('a topo-fallback edge or vertex ref names its body too', () => {
    const bodyStore: Record<string, Body> = { body_ex1: body('body_ex1'), body_ex2: body('body_ex2') }

    const result = solveDeleteBody(
      oc, scope, new HandleTable({ finalizerGuard: false }),
      { id: 'd', delete_body: { bodies: ['@body_ex1/edge/3', '@body_ex2/vertex/0'] } },
      new Repository(), bodyStore,
    )

    expect(result.deleted_body_ids).toEqual(['body_ex1', 'body_ex2'])
    expect(Object.keys(bodyStore)).toEqual([])
  })

  it('a topo-fallback ref naming a split sibling deletes only that sibling', () => {
    // The leading segment is a BODY id, so it must not be read as a feature and
    // pull the sibling down with it.
    const bodyStore: Record<string, Body> = { body_ex1: body('body_ex1'), body_ex1_1: body('body_ex1_1') }
    bodyStore.body_ex1.created_by = 'ex1'
    bodyStore.body_ex1_1.created_by = 'ex1'

    const result = solveDeleteBody(
      oc, scope, new HandleTable({ finalizerGuard: false }),
      { id: 'd', delete_body: { bodies: ['@body_ex1_1/face/2'] } }, new Repository(), bodyStore,
    )

    expect(result.deleted_body_ids).toEqual(['body_ex1_1'])
    expect(Object.keys(bodyStore)).toEqual(['body_ex1'])
  })

  it('a face query the repo can no longer resolve still deletes its body', () => {
    // The picked face is gone (a later edit reshaped the body under it), but the
    // body the feature named is still there. Failing the solve over an element
    // nobody asked to keep is the wrong answer; the `@body_*` ancestor the query
    // carries is the right one.
    const bodyStore: Record<string, Body> = { body_ex1: body('body_ex1'), body_b: body('body_b') }
    const staleFaceQuery = '?15,4,9,7;@u|u_f38db052aaf9026c@ex1@body_ex1@cls_zn:flatface'

    const result = solveDeleteBody(
      oc, scope, new HandleTable({ finalizerGuard: false }),
      { id: 'd', delete_body: { bodies: [staleFaceQuery] } }, new Repository(), bodyStore,
    )

    expect(result.deleted_body_ids).toEqual(['body_ex1'])
    expect(Object.keys(bodyStore)).toEqual(['body_b'])
  })

  it('a resolvable face query answers with the face owner, not the first ancestor', () => {
    // Repo before ancestry: a boolean face descends from BOTH inputs, so the
    // query carries two `@body_*` ancestors and only the repo knows which one
    // ended up owning the face.
    const repo = new Repository()
    repo.registerAncestor(['@body_a', '@body_b'], { type: 'face', body_id: 'body_b', created_by: 'bool1' })
    const bodyStore: Record<string, Body> = { body_a: body('body_a'), body_b: body('body_b') }
    const faceQuery = makeAncestryQuery(['@body_a', '@body_b'], 'face')
    // The fallback alone would answer with the other body, so this discriminates.
    expect(resolveBodyIds(faceQuery, bodyStore)).toEqual(['body_a'])

    const result = solveDeleteBody(
      oc, scope, new HandleTable({ finalizerGuard: false }),
      { id: 'd', delete_body: { bodies: [faceQuery] } }, repo, bodyStore,
    )

    expect(result.deleted_body_ids).toEqual(['body_b'])
    expect(Object.keys(bodyStore)).toEqual(['body_a'])
  })

  it('an exact body id still deletes exactly that one sibling', () => {
    const bodyStore: Record<string, Body> = { body_ex1: body('body_ex1'), body_ex1_1: body('body_ex1_1') }
    bodyStore.body_ex1.created_by = 'ex1'
    bodyStore.body_ex1_1.created_by = 'ex1'

    const result = solveDeleteBody(oc, scope, new HandleTable({ finalizerGuard: false }), { id: 'd', delete_body: { bodies: ['body_ex1_1'] } }, new Repository(), bodyStore)

    expect(result.deleted_body_ids).toEqual(['body_ex1_1'])
    expect(Object.keys(bodyStore)).toEqual(['body_ex1'])
  })
})
