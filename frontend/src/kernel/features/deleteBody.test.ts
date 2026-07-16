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

    const result = solveDeleteBody(oc, scope, table, { id: 'd', delete_body: { body: 'body_a' } }, new Repository(), bodyStore)

    expect(result).toEqual({ status: 'ok', deleted_body_id: 'body_a' })
    expect(Object.keys(bodyStore)).toEqual(['body_b'])
    expect(deleted).toBe(true)
  })

  it('throws when the body ref does not resolve', () => {
    expect(() =>
      solveDeleteBody(oc, scope, new HandleTable({ finalizerGuard: false }), { id: 'd', delete_body: { body: 'nope' } }, new Repository(), { body_b: body('body_b') }),
    ).toThrow()
  })
})
