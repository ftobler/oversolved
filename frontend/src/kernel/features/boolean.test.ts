// Always-on tests for the boolean leaf's OCC-free guard paths (phase 2f). The
// geometry paths are gated in booleanSolveReal.test.ts.

import { describe, it, expect } from 'vitest'
import { Repository } from '../query'
import { solveBoolean } from './boolean'
import { HandleTable } from '../occ/handleTable'
import type { OccModule } from '../occ/occTypes'
import type { Body } from '../types3d'

const oc = null as unknown as OccModule
const scope = null as never
const table = null as unknown as HandleTable
const repo = new Repository()

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

describe('solveBoolean guard paths', () => {
  it('requires a target', () => {
    expect(() =>
      solveBoolean(oc, scope, table, { id: 'b', boolean: { tools: ['body_u0'] } }, repo, { body_u0: body('body_u0') }),
    ).toThrow(/'target' is required/)
  })

  it('requires at least one tool', () => {
    expect(() =>
      solveBoolean(oc, scope, table, { id: 'b', boolean: { target: 'body_t', tools: [] } }, repo, { body_t: body('body_t') }),
    ).toThrow(/must have at least one entry/)
  })

  it('rejects an unknown operation', () => {
    expect(() =>
      solveBoolean(
        oc,
        scope,
        table,
        { id: 'b', boolean: { operation: 'xor', target: 'body_t', tools: ['body_u0'] } },
        repo,
        { body_t: body('body_t'), body_u0: body('body_u0') },
      ),
    ).toThrow(/unknown operation 'xor'/)
  })

  it('throws when tool body does not exist', () => {
  })

  it('throws when target body does not exist', () => {
    // Target body that does not exist should raise.
    expect(() =>
      solveBoolean(oc, scope, table, {
        id: 'b', boolean: { operation: 'union', target: '@body_missing', tools: ['body_u0'] },
      }, repo, {
        body_u0: body('body_u0'),
      }),
    ).toThrow(/body not found/)
  })

  it('target listed in tools throws the named error before any boolean runs', () => {
    // The refusal sits in the tool loop, so the target must reach it: a real
    // shape (any disposable) keeps the pre-loop "has no shape" guard from
    // firing first. The throw happens before any OCC work.
    const table = new HandleTable({ finalizerGuard: false })
    const target = body('body_t')
    target.shape = table.register({ delete: () => {}, isDeleted: () => false })
    expect(() =>
      solveBoolean(oc, scope, table, {
        id: 'b', boolean: { operation: 'union', target: 'body_t', tools: ['body_t'] },
      }, repo, {
        body_t: target,
      }),
    ).toThrow(/cannot be its own tool/)
  })

  it('an alias tool ref that resolves to the target is refused the same way', () => {
    // The id comparison catches aliases too: '@ex1' and 'body_t' are the same
    // body, and resolving the tool must not be allowed to eat the target.
    const table = new HandleTable({ finalizerGuard: false })
    const target = body('body_t')
    target.created_by = 'ex1'
    target.shape = table.register({ delete: () => {}, isDeleted: () => false })
    expect(() =>
      solveBoolean(oc, scope, table, {
        id: 'b', boolean: { operation: 'union', target: 'body_t', tools: ['@ex1'] },
      }, repo, {
        body_t: target,
      }),
    ).toThrow(/cannot be its own tool/)
  })
})
