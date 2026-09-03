// Always-on tests for the hole leaf's OCC-free guard paths (phase 2f). The
// drilling paths are gated in holeReal.test.ts.

import { describe, it, expect } from 'vitest'
import { Repository, makeAncestryQuery } from '../query'
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

  it('a zero-placed hole fails before touching modified_by', () => {
    // The zero-placed branch leaves brep_diff stale on purpose; pushing
    // modified_by before the throw made ancestry re-read that stale diff and
    // re-attribute the previous op's sub-shapes to the failed hole.
    const repo = new Repository()
    repo.register('_pt_sk', PLANE)
    const table = { get: () => null } as unknown as HandleTable
    const body = { ...nullBody('body_t'), shape: 1 as never, modified_by: ['ex_t'] }
    expect(() =>
      solveHole(oc, scope, table, { id: 'h9', hole: { sketch: '@sk', target: 'body_t' } }, repo, {
        body_t: body,
      }, { sk: { entities: [{ id: 'p1', kind: 'point' }] } }),
    ).toThrow(/nothing to place/)
    expect(body.modified_by).toEqual(['ex_t'])
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

// ─── Viewport picks in the sketch field ───
//
// The hole's Sketch chip holds whatever the viewport toggled, so every one of
// these ref forms is a click a user can make: a curve or a vertex in the 3D
// view (`entity:`/`vertex:`), or an area fill (a `?` ancestry query). All of
// them used to reach `_pt_<raw ref>` and red the feature out with "has no plane
// transform registered", which named nothing the user could act on.
describe('solveHole sketch picks', () => {
  const TWO_POINTS = { sk: { entities: [{ id: 'p1', kind: 'point' }, { id: 'p2', kind: 'point' }] } }

  function repoWithPlane(): Repository {
    const repo = new Repository()
    repo.register('_pt_sk', PLANE)
    return repo
  }

  function drill(sketch: string, features: Record<string, unknown> = TWO_POINTS, repo = repoWithPlane()) {
    // The drill loop reads the target's shape before it ever places a cylinder,
    // so the guard paths need a table that answers; none of these cases gets as
    // far as an OCC call.
    const stub = { get: () => null } as unknown as HandleTable
    return solveHole(oc, scope, stub, { id: 'h', hole: { sketch, target: 'body_t' } }, repo, {
      body_t: { ...nullBody('body_t'), shape: 1 as never },
    }, features as Record<string, never>)
  }

  it('reads a curve pick as its own sketch, not as a missing one', () => {
    // Names the line and what to pick instead: the old answer was
    // "sketch 'entity:sk:ln' has no plane transform registered".
    expect(() => drill('entity:sk:ln', { sk: { entities: [{ id: 'ln', kind: 'line' }] } }))
      .toThrow(/'ln' of sketch sk is a line, which names no drill site/)
  })

  it('drills only the point a vertex pick names', () => {
    // Both points lack XY data, so the count in the message is the whole drill
    // set: 1 means p2 was never in it. Drilling every point of the sketch when
    // the user clicked one of them would be a silent extra hole.
    expect(() => drill('vertex:sk:p1:xy')).toThrow(/all 1 drill site\(s\)/)
    expect(() => drill('@sk')).toThrow(/all 2 drill site\(s\)/)
  })

  it('narrows an area pick bounded by one entity to that entity', () => {
    // Clicking the fill inside a lone circle and clicking the circle itself are
    // the same gesture; the area form has to answer the same way.
    const q = makeAncestryQuery(['@sk/ci', 'surface:0', '@sk'], 'flatface')
    expect(() => drill(q, { sk: { entities: [{ id: 'ci', kind: 'circle' }, { id: 'p1', kind: 'point' }] } }))
      .toThrow(/all 1 drill site\(s\)/)
  })

  it('keeps the whole sketch for an area several entities bound', () => {
    // A rectangle's region names four lines and no single drill site, so the
    // pick keeps meaning what `@sk` means: every point in the sketch.
    const q = makeAncestryQuery(['@sk/ln_a', '@sk/ln_b', 'surface:0', '@sk'], 'flatface')
    expect(() => drill(q)).toThrow(/all 2 drill site\(s\)/)
  })

  it('refuses a query that names no sketch, by name', () => {
    // A body face in the sketch field: nothing to narrow, and nothing to guess.
    const q = makeAncestryQuery(['@body_ex1', '@ex1'], 'flatface')
    expect(() => drill(q)).toThrow(/has no plane transform registered/)
  })

  it('refuses an entity the sketch does not have', () => {
    expect(() => drill('entity:sk:nope')).toThrow(/sketch 'sk' has no entity 'nope'/)
  })
})
