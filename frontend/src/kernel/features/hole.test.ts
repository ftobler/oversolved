// Always-on tests for the hole leaf's OCC-free guard paths (phase 2f). The
// drilling paths are gated in holeReal.test.ts.

import { describe, it, expect } from 'vitest'
import { Repository } from '../query'
import { solveHole } from './hole'
import type { HandleTable } from '../occ/handleTable'
import type { OccModule } from '../occ/occTypes'
import type { Body } from '../types3d'

const oc = null as unknown as OccModule
const scope = null as never
const table = null as unknown as HandleTable

const PLANE = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }

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

describe('solveHole guard paths', () => {
  it('throws when the sketch plane is not registered', () => {
    expect(() =>
      solveHole(oc, scope, table, { id: 'h', hole: { sketch: '@sk', target: 'body_t' } }, new Repository(), { body_t: nullBody('body_t') }, {}),
    ).toThrow(/has no plane transform registered/)
  })

  it('throws when there are no bodies and no target', () => {
    const repo = new Repository()
    repo.register('_pt_sk', PLANE)
    expect(() =>
      solveHole(oc, scope, table, { id: 'h', hole: { sketch: '@sk' } }, repo, {}, {}),
    ).toThrow(/no bodies in body_store and no target specified/)
  })

  it('throws when the target body has no shape', () => {
    const repo = new Repository()
    repo.register('_pt_sk', PLANE)
    expect(() =>
      solveHole(oc, scope, table, { id: 'h', hole: { sketch: '@sk', target: 'body_t' } }, repo, { body_t: nullBody('body_t') }, {}),
    ).toThrow(/has no shape/)
  })

  it('throws when sketch has no point entities', () => {
    // Hole referenced sketch with no point entities raises.
    const repo = new Repository()
    repo.register('_pt_sk', PLANE)
    expect(() =>
      solveHole(oc, scope, table, { id: 'h', hole: { sketch: '@sk', target: 'body_t' } }, repo, {
        body_t: { ...nullBody('body_t'), shape: 1 as never },
      }, { sk: { entities: [{ id: 'l1', kind: 'line' }] } }),
    ).toThrow(/has no point entities/)
  })

  it('throws when all points have no XY data (ported to holeReal.test.ts)', () => {
  })

  it('throws when target body does not exist', () => {
    // Non-existent target body raises.
    const repo = new Repository()
    repo.register('_pt_sk', PLANE)
    expect(() =>
      solveHole(oc, scope, table, { id: 'h', hole: { sketch: '@sk', target: '@body_missing' } }, repo, {
        body_ex1: nullBody('body_ex1'),
      }, { sk: { entities: [{ id: 'p1', kind: 'point' }] } }),
    ).toThrow(/body not found/)
  })
})
