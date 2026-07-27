// Always-on tests for the delete_body leaf (features/deleteBody.ts). delete_body
// is pure store logic + handle release, so it needs no OCC: a stub Disposable
// stands in for a body shape to verify the HandleTable handle is released.

import { describe, it, expect } from 'vitest'
import { Repository } from '../query'
import { HandleTable } from '../occ/handleTable'
import { solveDeleteBody } from './deleteBody'
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
})
