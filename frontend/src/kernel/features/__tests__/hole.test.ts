// Always-on tests for the hole leaf's OCC-free guard paths (phase 2f). The
// drilling paths are gated in holeReal.test.ts.

import { describe, it, expect } from 'vitest'
import { Repository, makeAncestryQuery } from '../../query'
import { solveHole } from '../hole'
import type { HandleTable } from '../../occ/handleTable'
import type { OccModule } from '../../occ/occTypes'
import type { Body } from '../../types3d'

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

  it('names the sketch a half-configured hole still needs', () => {
    for (const hole of [{}, { sketch: '' }, { sketch: '  ' }]) {
      expect(() =>
        solveHole(oc, scope, table, { id: 'h', hole }, new Repository(), {}, {}),
      ).toThrow(/the hole needs a sketch/)
    }
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
    // A sketch of lines names no drill site at all: the hole drills points.
    const repo = new Repository()
    repo.register('_pt_sk', PLANE)
    expect(() =>
      solveHole(oc, scope, table, { id: 'h', hole: { sketch: '@sk', target: 'body_t' } }, repo, {
        body_t: { ...nullBody('body_t'), shape: 1 as never },
      }, { sk: { entities: [{ id: 'l1', kind: 'line' }] } }),
    ).toThrow("hole: sketch 'sk' has no point entities; the hole needs a point in its sketch to drill")
  })

  it('names construction when every point in the sketch is construction', () => {
    // A construction-flagged point exists in a hand-authored or imported
    // document as well as one the toggle flagged. Reference geometry is not a
    // drill site, so a sketch with nothing else to drill must be refused for
    // construction, not "has no point entities".
    const repo = new Repository()
    repo.register('_pt_sk', PLANE)
    const drill = (entities: Array<Record<string, unknown>>) =>
      solveHole(oc, scope, table, { id: 'h', hole: { sketch: '@sk', target: 'body_t' } }, repo, {
        body_t: { ...nullBody('body_t'), shape: 1 as never },
      }, { sk: { entities } })
    expect(() => drill([
      { id: 'pc', kind: 'point', construction: true },
      { id: 'cc', kind: 'circle', construction: true },
    ])).toThrow(/has no drillable non-construction point.*clear the circle's construction flag, then cut it with an extrude cut/)
    // An n-gon sketch has non-construction lines, but its only circle is the
    // construction circumcircle, so it still has no point to drill.
    expect(() => drill([
      { id: 'l1', kind: 'line' },
      { id: 'l2', kind: 'line' },
      { id: 'cc', kind: 'circle', construction: true },
    ])).toThrow(/has no point entities.*clear the circle's construction flag, then cut it with an extrude cut/)
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

  it('narrows an area pick bounded by one point to that point', () => {
    // An area fill bounded by a lone point names that point alone, the same
    // narrowing the viewport's entity pick gets.
    const q = makeAncestryQuery(['@sk/p1', 'surface:0', '@sk'], 'flatface')
    expect(() => drill(q, { sk: { entities: [{ id: 'p1', kind: 'point' }] } }))
      .toThrow(/all 1 drill site\(s\)/)
  })

  it('keeps the whole sketch for an area several entities bound', () => {
    // A rectangle's region names four lines and no single drill site, so the
    // pick keeps meaning what `@sk` means: every non-construction point in the
    // sketch.
    const q = makeAncestryQuery(['@sk/ln_a', '@sk/ln_b', 'surface:0', '@sk'], 'flatface')
    expect(() => drill(q)).toThrow(/all 2 drill site\(s\)/)
  })

  it('refuses a query that names no sketch, by name', () => {
    // A body face in the sketch field: nothing to narrow, and nothing to guess.
    const q = makeAncestryQuery(['@body_ex1', '@ex1'], 'flatface')
    expect(() => drill(q)).toThrow(/has no plane transform registered/)
  })

  it('refuses a construction point picked as a drill site, by name', () => {
    // Construction geometry is never a drill site: an explicit pick of one is
    // refused with construction named as the reason, not silently skipped.
    expect(() => drill('entity:sk:pc', {
      sk: { entities: [{ id: 'pc', kind: 'point', construction: true }] },
    })).toThrow(/'pc' of sketch sk is a construction point, which names no drill site.*toggle its construction off to drill it/)
  })

  it('names both remedies when a construction point sits beside a real circle', () => {
    // The old branch called this "has only construction points", which was false
    // (the circle is not a point) and dropped the extrude alternative the circle
    // makes possible.
    expect(() => drill('@sk', {
      sk: { entities: [{ id: 'pc', kind: 'point', construction: true }, { id: 'c1', kind: 'circle' }] },
    })).toThrow(/has no drillable non-construction point.*clear the point's construction flag.*cut the circle with an extrude cut/)
  })

  it('refuses a picked circle with the extrude-cut remedy', () => {
    // A circle is a profile, not a drill site: drilling it would repeat the
    // extrude cut at a size the hole's own `diameter` cannot state. The refusal
    // names the operation that does cut the disc.
    expect(() => drill('entity:sk:c1', { sk: { entities: [{ id: 'c1', kind: 'circle' }] } }))
      .toThrow(/'c1' of sketch sk is a circle, which is not a drill site.*put a point at the circle's centre, or cut the circle with an extrude cut/)
    expect(() => drill('vertex:sk:c1:center', { sk: { entities: [{ id: 'c1', kind: 'circle' }] } }))
      .toThrow(/'c1' of sketch sk is a circle, which is not a drill site/)
    const q = makeAncestryQuery(['@sk/c1', 'surface:0', '@sk'], 'flatface')
    expect(() => drill(q, { sk: { entities: [{ id: 'c1', kind: 'circle' }] } }))
      .toThrow(/'c1' of sketch sk is a circle, which is not a drill site/)
  })

  it('tells a picked construction circle to clear its flag before the extrude cut', () => {
    // A construction circle is excluded from profiles, so the plain extrude-cut
    // remedy cannot work until the flag is cleared.
    for (const ref of ['entity:sk:cc', 'vertex:sk:cc:center']) {
      expect(() => drill(ref, { sk: { entities: [{ id: 'cc', kind: 'circle', construction: true }] } }))
        .toThrow(/is a construction circle, which is not a drill site.*clear the circle's construction flag, then cut it with an extrude cut/)
    }
    const q = makeAncestryQuery(['@sk/cc', 'surface:0', '@sk'], 'flatface')
    expect(() => drill(q, { sk: { entities: [{ id: 'cc', kind: 'circle', construction: true }] } }))
      .toThrow(/is a construction circle.*clear the circle's construction flag, then cut it with an extrude cut/)
  })

  it('names the extrude-cut alternative for a circles-only sketch', () => {
    // A whole-sketch pick drills points only, so a sketch of circles has no
    // drill site; the refusal points at the operation that cuts them.
    expect(() => drill('@sk', {
      sk: { entities: [{ id: 'c1', kind: 'circle' }, { id: 'c2', kind: 'circle' }] },
    })).toThrow(/has no point entities.*put a point at the circle's centre, or cut the circle with an extrude cut/)
  })

  it('refuses a construction line with the plain kind refusal', () => {
    // The construction remedy speaks about points; a construction line names no
    // drill site for its kind, so it must not be told to add a plain point.
    expect(() => drill('entity:sk:ln', {
      sk: { entities: [{ id: 'ln', kind: 'line', construction: true }] },
    })).toThrow(/'ln' of sketch sk is a line, which names no drill site; pick a sketch point, or the sketch itself/)
  })

  it('refuses a line vertex pick: line endpoints are not drill sites', () => {
    // Clicking a line's endpoint in the viewport is a vertex pick, but a vertex
    // of a line is still not a hole site.
    expect(() => drill('vertex:sk:ln:start', {
      sk: { entities: [{ id: 'ln', kind: 'line' }] },
    })).toThrow(/'ln' of sketch sk is a line, which names no drill site/)
  })

  it('refuses a construction point through the vertex and area pick forms too', () => {
    // The narrowing forms reach the same decode with an entity id, so the
    // refusal must hold there and not only for an `entity:` pick.
    expect(() => drill('vertex:sk:pc:xy', {
      sk: { entities: [{ id: 'pc', kind: 'point', construction: true }] },
    })).toThrow(/is a construction point, which names no drill site/)
    const q = makeAncestryQuery(['@sk/pc', 'surface:0', '@sk'], 'flatface')
    expect(() => drill(q, {
      sk: { entities: [{ id: 'pc', kind: 'point', construction: true }] },
    })).toThrow(/is a construction point, which names no drill site/)
  })

  it('refuses an entity the sketch does not have', () => {
    expect(() => drill('entity:sk:nope')).toThrow(/sketch 'sk' has no entity 'nope'/)
  })

  it('drills every non-construction point a whole-sketch pick names and ignores its circles', () => {
    // The whole-sketch meaning is every point: the circles beside it are
    // profiles, not drill sites. None has solved geometry here, so the count in
    // the message is the whole drill set. The feature diameter is the real
    // kernel suite's to pin.
    expect(() => drill('@sk', {
      sk: { entities: [{ id: 'c1', kind: 'circle' }, { id: 'p1', kind: 'point' }, { id: 'c2', kind: 'circle' }] },
    })).toThrow(/all 1 drill site\(s\)/)
  })

  it('drills one site from a sketch with one point and one circle', () => {
    // The plan's whole-sketch case: the point is the site, the circle is not.
    expect(() => drill('@sk', {
      sk: { entities: [{ id: 'p1', kind: 'point' }, { id: 'c1', kind: 'circle' }] },
    })).toThrow(/all 1 drill site\(s\)/)
  })

  it('leaves a construction point out of a whole-sketch pick', () => {
    // The point carries the flag toggle_construction sets, so it is reference
    // geometry and only the plain point is a site. The count is the whole drill
    // set because neither site has solved geometry here.
    expect(() => drill('@sk', {
      sk: { entities: [{ id: 'pc', kind: 'point', construction: true }, { id: 'p1', kind: 'point' }] },
    })).toThrow(/all 1 drill site\(s\)/)
  })

  it('refuses a sketch whose only point is construction, naming the flag it can clear', () => {
    // Flagging the last drill site must fail by name rather than drill nothing
    // or drill the reference point.
    expect(() => drill('@sk', {
      sk: { entities: [{ id: 'pc', kind: 'point', construction: true }] },
    })).toThrow(/has only construction points.*clear the point's construction flag/)
  })
})
