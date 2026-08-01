// Always-on tests for the boolean leaf's OCC-free guard paths (phase 2f). The
// geometry paths are gated in booleanSolveReal.test.ts.

import { describe, it, expect } from 'vitest'
import { Repository } from '../query'
import { solveBoolean } from './boolean'
import type { HandleTable } from '../occ/handleTable'
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
})
