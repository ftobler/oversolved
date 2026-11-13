// @vitest-environment node
//
// Integration: solveSketch lowers a projected entity through the real Rust WASM
// solver. Guards the params-into-`initial` fix -- without it a projected entity
// solves to the origin instead of its projected location -- and the tilted
// circle -> ellipse kind promotion (full-brep-projection).
import { describe, it, expect, beforeEach } from 'vitest'
import {
  solveSketch, setSketchSolver, resetSketchSolver,
  prepareDragContext, solveSketchDrag, pinProjectionTargets,
} from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { worldToSketch2d } from '../shared/planes'
import { unflattenGeometry } from '@/utils/geometry/geometryMapping'
import type { Repository } from '../../query'
import type { Body } from '../../types3d'
import type { PartEntityDef, SketchFeature } from '@/types/cad'

type Dict = Record<string, unknown>

const solveBytes = loadSolver()

/** Minimal repository stub: returns a fixed payload for any source query. */
function stubRepo(payload: Dict): Repository {
  return {
    query: () => payload,
    elements: new Map(),
  } as unknown as Repository
}

/** Repository stub that never resolves a query (stale ancestry / missing edge). */
function deadRepo(): Repository {
  return { query: () => null, elements: new Map() } as unknown as Repository
}

/** The entity ids the sketch solve left in its profile topology. */
type ProfileTopology = { edges?: Array<{ entity_id: string }> }
function profileEntityIds(out: Dict): string[] {
  return ((out.topology as ProfileTopology | undefined)?.edges ?? []).map((e) => e.entity_id)
}

describe('solveSketch projection lowering', () => {
  beforeEach(() => {
    resetSketchSolver()
    if (solveBytes) setSketchSolver(solveBytes)
  })

  const onParallelCircle: Dict = {
    type: 'edge', kind: 'circle', center: [3, 4, 0], radius: 5, axis: [0, 0, 1], x_axis: [1, 0, 0],
  }

  it('projects a parallel circle to its 2D location (params reach the solver)', () => {
    if (!solveBytes) return  // solver wasm absent: skip
    const feature: Dict = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'c0', kind: 'circle' }],
      initial: {},
      constraints: [
        { id: 'proj_c0', kind: 'projection', target: '$c0', source: '?edge;circle' },
      ],
    }
    const out = solveSketch(feature, stubRepo(onParallelCircle), {} as Record<string, Body>)
    expect(out.status).not.toBe('error')
    const g = out.geometry?.c0
    expect(g).toBeDefined()
    expect(g![0]).toBeCloseTo(3)
    expect(g![1]).toBeCloseTo(4)
    expect(g![2]).toBeCloseTo(5)
  })

  it('promotes a tilted circle to a solved ellipse', () => {
    if (!solveBytes) return
    const phi = Math.PI / 3
    const tilted: Dict = {
      type: 'edge', kind: 'circle', center: [0, 0, 0], radius: 5,
      axis: [0, -Math.sin(phi), Math.cos(phi)], x_axis: [1, 0, 0],
    }
    const feature: Dict = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'e0', kind: 'circle' }],
      initial: {},
      constraints: [
        { id: 'proj_e0', kind: 'projection', target: '$e0', source: '?edge;circle' },
      ],
    }
    const out = solveSketch(feature, stubRepo(tilted), {} as Record<string, Body>)
    expect(out.status).not.toBe('error')
    const g = out.geometry?.e0
    expect(g).toBeDefined()
    // 5 params => the entity was lowered to an ellipse, not kept as a circle.
    expect(g!.length).toBe(5)
    expect(g![2]).toBeCloseTo(5)  // a = R
    expect(g![3]).toBeCloseTo(5 * Math.cos(phi))  // b = R cos(phi)
    // The kind change must be surfaced so the doc entity (declared 'circle')
    // adopts 'ellipse' -- otherwise a 'circle' entity gets 5-param geometry.
    expect(out.resolved_kinds?.e0).toBe('ellipse')
  })

  it('surfaces resolved_kinds=fit_spline for a partial elliptical edge (declared ellipse)', () => {
    if (!solveBytes) return
    const partialEllipse: Dict = {
      type: 'edge', kind: 'ellipse', center: [0, 0, 0], a: 4, b: 2,
      axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI / 2,
    }
    const feature: Dict = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'ell0', kind: 'ellipse' }],
      initial: {},
      constraints: [
        { id: 'proj_ell0', kind: 'projection', target: '$ell0', source: '?edge;ellipse' },
      ],
    }
    const out = solveSketch(feature, stubRepo(partialEllipse), {} as Record<string, Body>)
    expect(out.status).not.toBe('error')
    // A quarter of this eccentric ellipse misses one cubic by 2.9e-3 of its
    // size, so it lowers to a fit spline: a 2N-point block the doc entity must
    // render as that kind, not as [cx,cy,a,b,theta].
    const g = out.geometry?.ell0
    expect(g).toBeDefined()
    expect(g!.length).toBeGreaterThan(8)
    expect(g!.length % 2).toBe(0)
    // The fit points ARE the projected ends, and a pinned projection passes the
    // solver round trip bit for bit.
    expect(g![0]).toBe(4)
    expect(g![1]).toBe(0)
    expect(g![g!.length - 2]).toBe(4 * Math.cos(Math.PI / 2))
    expect(g![g!.length - 1]).toBe(2)
    expect(out.resolved_kinds?.ell0).toBe('fit_spline')
  })

  it('converges: a doc entity already a fit_spline re-solves from an ellipse source', () => {
    if (!solveBytes) return
    // Second solve after convergence: the doc entity kind is now 'fit_spline'
    // (it adopted the resolved kind last solve) but its source edge is still an
    // ellipse. Projection must branch on the resolved geometry, not the declared
    // kind, or the spline branch reads a non-existent points array and fails.
    const partialEllipse: Dict = {
      type: 'edge', kind: 'ellipse', center: [0, 0, 0], a: 4, b: 2,
      axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI / 2,
    }
    const feature: Dict = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'ell0', kind: 'fit_spline' }],
      initial: {},
      constraints: [
        { id: 'proj_ell0', kind: 'projection', target: '$ell0', source: '?edge;ellipse' },
      ],
    }
    const out = solveSketch(feature, stubRepo(partialEllipse), {} as Record<string, Body>)
    expect(out.status).not.toBe('error')
    expect(out.geometry?.ell0!.length).toBeGreaterThan(8)
    expect(out.resolved_kinds).toBeUndefined()  // already fit_spline -> no further change
  })

  it('warns when a sampled curve fit cannot meet its tolerance', () => {
    if (!solveBytes) return
    // A sawtooth payload no 64-point interpolating spline can follow: the fit
    // must stop at the cap, keep its best effort, and still solve. The warning
    // is what keeps the accuracy loss visible on the sketch instead of shipping
    // a silently coarse curve.
    const points: number[][] = []
    for (let i = 0; i <= 200; i++) points.push([i / 200, i % 2 === 0 ? 1 : -1, 0])
    const feature: Dict = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'sp0', kind: 'spline' }],
      initial: {},
      constraints: [
        { id: 'proj_sp0', kind: 'projection', target: '$sp0', source: '?edge;spline' },
      ],
    }
    const out = solveSketch(
      feature, stubRepo({ type: 'edge', kind: 'spline', points }), {} as Record<string, Body>,
    )
    expect(out.status).not.toBe('error')
    expect(out.geometry?.sp0.length).toBeGreaterThan(8)
    expect(out.geometry!.sp0.length).toBeLessThanOrEqual(132)
    expect(out.solver_warning).toContain('projection proj_sp0: curve fit stopped at')
    expect(out.solver_warning).toContain('the closest fit is kept')
  })

  it('drops a spline control-point constraint when the projection resolves to fit_spline', () => {
    if (!solveBytes) return
    // A `spline`'s c1/c2 are Bezier controls, not points on the interpolating
    // spline a fit_spline describes. Once the projection resolves the entity to
    // fit_spline, the key-existence rule in partDocToSketches must drop the row
    // by name instead of binding it to the first fit point, which would silently
    // move what the user asked for. The general kind-applicability table is
    // feature/projection-kind-change-operands.md; this pins the half the
    // lowering already owns.
    //
    // Today the resolved kind reaches partDocToSketches only through the
    // in-place kind write in lowerProjectionConstraints, which
    // feature/projection-lowering-hygiene removes. After that lands the
    // resolved kinds must be threaded into partDocToSketches for this drop to
    // keep firing; that threading is not this change's job.
    const partialEllipse: Dict = {
      type: 'edge', kind: 'ellipse', center: [0, 0, 0], a: 4, b: 2,
      axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI / 2,
    }
    const feature: Dict = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [
        { id: 'sp0', kind: 'spline' },
        { id: 'p0', kind: 'point' },
      ],
      initial: { p0: [1, 1] },
      constraints: [
        { id: 'proj_sp0', kind: 'projection', target: '$sp0', source: '?edge;ellipse' },
        {
          id: 'c_p0_c1', kind: 'coincident',
          a: { entity: 'p0', point: 'xy' }, b: { entity: 'sp0', point: 'c1' },
        },
      ],
    }
    const out = solveSketch(feature, stubRepo(partialEllipse), {} as Record<string, Body>)
    expect(out.status).not.toBe('error')
    expect(out.resolved_kinds?.sp0).toBe('fit_spline')
    expect(out.dropped_constraints).toContainEqual({
      id: 'c_p0_c1', kind: 'coincident', reason: 'operand c1 not on fit_spline',
    })
    // The dropped row carries no residual: the free point keeps its position.
    expect(out.geometry?.p0).toEqual([1, 1])
    // The drop is solve-time only: the authored row stays in the document, so a
    // source that resolves back re-enables it on the next solve.
    const kept = (feature.constraints as Dict[]).filter(c => c.id === 'c_p0_c1')
    expect(kept).toHaveLength(1)
    expect(kept[0].kind).toBe('coincident')
  })

  it('drops an unresolvable projection and still solves the rest of the sketch', () => {
    if (!solveBytes) return
    // A stale projection (source no longer resolves) must NOT throw the whole
    // sketch -- it is dropped, the user's own geometry still solves, and the
    // dropped id is reported. Regression for "the whole sketch went inert".
    // The stale entity is a fit_spline on purpose: its default block is two fit
    // points, a real segment the area builder would otherwise keep as a profile
    // edge, so this pins the exclusion rather than a curve that dies on its own.
    const entities = [
      { id: 'drawn', kind: 'circle' },
      { id: 'stale', kind: 'fit_spline' },
    ]
    const feature: Dict = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities,
      initial: { drawn: [2, 3, 4] },
      constraints: [
        { id: 'proj_stale', kind: 'projection', target: '$stale', source: '?edge;gone' },
      ],
    }
    const out = solveSketch(feature, deadRepo(), {} as Record<string, Body>)
    expect(out.status).not.toBe('exception')
    expect(out.status).not.toBe('error')
    // The drawn circle solved and renders.
    expect(out.geometry?.drawn).toBeDefined()
    expect(out.geometry?.drawn?.[2]).toBeCloseTo(4)
    expect(out.projection_errors).toContain('proj_stale')
    // It never had a position, so nothing is baked and nothing reaches the
    // profile: an all-zero curve at the origin must not become a profile edge.
    expect(out.geometry?.stale).toBeUndefined()
    const profileIds = profileEntityIds(out)
    expect(profileIds).not.toContain('stale')
    expect(out.solver_warning).toContain(
      'projection proj_stale source ?edge;gone did not resolve; '
      + 'the entity has no position yet and is left out of the profile',
    )
    // Chosen rule for display: the entity is not filtered out of the sketch view,
    // it falls back to the same default block, so the user can still delete it.
    const view = unflattenGeometry(out.geometry, entities as unknown as PartEntityDef[])
    expect(view.stale).toBeDefined()
  })

  it('treats a stored default block as no position (the old baked zero curve)', () => {
    if (!solveBytes) return
    // Regression for documents written by the old fallback: it baked the kind's
    // default params for a fresh projection that never resolved, so the doc holds
    // an all-zero spline. That block is not a position; anything but this
    // exclusion keeps the degenerate curve in the profile forever.
    const feature: Dict = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [
        { id: 'drawn', kind: 'circle' },
        { id: 'stale', kind: 'spline' },
      ],
      initial: { drawn: [2, 3, 4], stale: [0, 0, 0, 0, 0, 0, 0, 0] },
      constraints: [
        { id: 'proj_stale', kind: 'projection', target: '$stale', source: '?edge;gone' },
      ],
    }
    const out = solveSketch(feature, deadRepo(), {} as Record<string, Body>)
    expect(out.geometry?.stale).toBeUndefined()
    expect(profileEntityIds(out)).not.toContain('stale')
    expect(out.solver_warning).toContain(
      'projection proj_stale source ?edge;gone did not resolve; '
      + 'the entity has no position yet and is left out of the profile',
    )
  })

  it('keeps an unresolved projection with a cached position in the solve and the profile', () => {
    if (!solveBytes) return
    // The other half of the rule: a projection whose source died still holds its
    // last resolved position, so it stays a pinned, valid profile edge.
    const feature: Dict = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [
        { id: 'drawn', kind: 'line' },
        { id: 'held', kind: 'line' },
      ],
      initial: { drawn: [0, 0, 4, 0], held: [0, 2, 4, 2] },
      constraints: [
        { id: 'proj_held', kind: 'projection', target: '$held', source: '?edge;gone' },
      ],
    }
    const out = solveSketch(feature, deadRepo(), {} as Record<string, Body>)
    expect(out.geometry?.held).toEqual([0, 2, 4, 2])
    expect(out.solver_warning).toContain(
      'projection proj_held source ?edge;gone did not resolve; the entity keeps its last position',
    )
    expect(profileEntityIds(out)).toContain('held')
  })

  it('runs a line body (not its endpoint) through the document origin on an offset plane', () => {
    if (!solveBytes) return
    // The "line constrained to origin" bug, as reported: a sketch on a face plane
    // offset from the global origin, a line selected as a whole entity (locus, no
    // vertex key) coincident with @builtin_origin. The correct reading is
    // point-on-line: the line BODY passes through the document origin, the
    // endpoint is NOT pinned to it. Two fixes combine here -- the origin resolves
    // to the projected DOCUMENT origin (not the plane's local 0,0), and
    // coincident(line, point) is point-on-line. The line is kept horizontal at a
    // fixed length so the solve is well-posed (an otherwise-free line + point-on-
    // line is degenerate: a zero-length line satisfies it trivially).
    const offsetPlane: Dict = {
      type: 'face', origin: [5, 10, -2], normal: [0, 0, 1], x_axis: [1, 0, 0], y_axis: [0, 1, 0],
    }
    // Document origin (0,0,0) in this plane's local frame: (0-5, 0-10) = (-5, -10).
    const feature: Dict = {
      id: 'sk1', kind: 'sketch', plane: '?face;flatface',
      entities: [{ id: 'ln', kind: 'line' }],
      initial: { ln: [0, 5, 10, 5] },
      constraints: [
        { id: 'c_horiz', kind: 'horizontal', target: '$ln' },
        { id: 'c_len', kind: 'length', target: '$ln', value: 10 },
        { id: 'c_co', kind: 'coincident', a: '$ln', b: '@builtin_origin' },
      ],
    }
    const out = solveSketch(feature, stubRepo(offsetPlane), {} as Record<string, Body>)
    expect(out.status).not.toBe('error')
    const g = out.geometry?.ln
    expect(g).toBeDefined()
    // Horizontal line through y = -10 (the document origin's local y): the line
    // body passes through the origin, but the segment keeps its length and
    // neither endpoint sits AT the origin.
    expect(g![1]).toBeCloseTo(-10)
    expect(g![3]).toBeCloseTo(-10)
    expect(Math.hypot(g![2] - g![0], g![3] - g![1])).toBeCloseTo(10)  // not collapsed
    const startAtOrigin = Math.abs(g![0] + 5) < 1e-6 && Math.abs(g![1] + 10) < 1e-6
    const endAtOrigin = Math.abs(g![2] + 5) < 1e-6 && Math.abs(g![3] + 10) < 1e-6
    expect(startAtOrigin || endAtOrigin).toBe(false)
  })

  it('does not surface a resolved kind when projection keeps the declared kind', () => {
    if (!solveBytes) return
    const feature: Dict = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'c0', kind: 'circle' }],
      initial: {},
      constraints: [
        { id: 'proj_c0', kind: 'projection', target: '$c0', source: '?edge;circle' },
      ],
    }
    const out = solveSketch(feature, stubRepo(onParallelCircle), {} as Record<string, Body>)
    // Parallel circle stays a circle -> no kind change -> no resolved_kinds.
    expect(out.resolved_kinds).toBeUndefined()
  })

  it('solves a projected quarter-circle arc pinned at its DEGREE angles', () => {
    if (!solveBytes) return
    // Regression for the projected-arc units: the lowering used to emit raw
    // atan2 radians into the degree-convention angle slots, and because a
    // projected entity's params are PINNED, even a coplanar quarter circle
    // solved/pinned at ~1.57 degrees of sweep.
    const projArc: Dict = {
      type: 'edge', kind: 'arc', center: [0, 0, 0], radius: 5,
      axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI / 2,
    }
    const feature: Dict = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'a0', kind: 'arc' }],
      initial: {},
      constraints: [
        { id: 'proj_a0', kind: 'projection', target: '$a0', source: '?edge;arc' },
      ],
    }
    const out = solveSketch(feature, stubRepo(projArc), {} as Record<string, Body>)
    expect(out.status).not.toBe('error')
    const g = out.geometry?.a0
    expect(g).toBeDefined()
    expect(g).toHaveLength(5)
    const [cx, cy, r, sa, ea] = g!
    expect(cx).toBeCloseTo(0)
    expect(cy).toBeCloseTo(0)
    expect(r).toBeCloseTo(5)
    expect(sa).toBeCloseTo(0)
    expect(ea).toBeCloseTo(90, 1)
  })

  it('legacy v5 row: an entity `source` still folds into a projection constraint', () => {
    if (!solveBytes) return
    // Documents written before the projection constraint carry `source` on the
    // entity. `lowerProjectionConstraints` folds that row into the constraint
    // form, and this is the one test that pins the fold itself rather than the
    // production spelling every other projection test authors.
    const legacy: Dict = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'c0', kind: 'circle', source: '?edge;circle' }],
      initial: {},
      constraints: [],
    }
    const constraintForm: Dict = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'c0', kind: 'circle' }],
      initial: {},
      constraints: [
        { id: 'proj_c0', kind: 'projection', target: '$c0', source: '?edge;circle' },
      ],
    }
    const folded = solveSketch(legacy, stubRepo(onParallelCircle), {} as Record<string, Body>)
    const explicit = solveSketch(constraintForm, stubRepo(onParallelCircle), {} as Record<string, Body>)
    expect(folded.geometry?.c0).toEqual(explicit.geometry?.c0)
    expect(folded.projection_errors).toBeUndefined()
  })
})

describe('solveSketch projects the document origin as a point', () => {
  beforeEach(() => {
    resetSketchSolver()
    if (solveBytes) setSketchSolver(solveBytes)
  })

  // The origin is registered as `{external_xy: [0,0]}` with no sketch, so the
  // lowerer lifts it to the document origin rather than the sketch plane's 0,0.
  const originPoint = { external_xy: [0, 0] }

  function repoOf(entries: Dict): Repository {
    return {
      // Repository keys strip the ref sigil: `@builtin_origin` reads the
      // `builtin_origin` element, exactly as production registers it.
      query: (q: string) => {
        const key = q.startsWith('@') ? q.slice(1) : q
        return key in entries ? entries[key] : null
      },
      elements: new Map(Object.entries(entries)),
    } as unknown as Repository
  }

  const originFeature = (plane: string): Dict => ({
    id: 'sk1', kind: 'sketch', plane,
    entities: [{ id: 'p0', kind: 'point' }],
    initial: {},
    constraints: [{ id: 'proj_p0', kind: 'projection', target: '$p0', source: '@builtin_origin' }],
  })

  it('lands at the document origin on Front, an offset plane and a face sketch', () => {
    if (!solveBytes) return
    const frontPlane = { origin: [0, 0, 0], normal: [0, 0, 1], x_axis: [1, 0, 0], y_axis: [0, 1, 0] }
    const offsetPlane = { origin: [5, 5, 10], normal: [0, 0, 1], x_axis: [1, 0, 0], y_axis: [0, 1, 0] }
    // The +Z face of the Ex002 block: x +Y, y -X, centroid 5 above the origin.
    const facePlane = { origin: [0, 0, 5], normal: [0, 0, 1], x_axis: [0, 1, 0], y_axis: [-1, 0, 0] }
    const cases = [
      { plane: '@builtin_plane_front', model: frontPlane, entries: { builtin_origin: originPoint } },
      { plane: 'op1', model: offsetPlane, entries: { builtin_origin: originPoint, op1: offsetPlane } },
      { plane: '?face', model: facePlane, entries: { builtin_origin: originPoint, '?face': facePlane } },
    ]
    for (const c of cases) {
      const out = solveSketch(originFeature(c.plane), repoOf(c.entries), {} as Record<string, Body>)
      const expected = worldToSketch2d([0, 0, 0], c.model)
      expect(out.projection_errors ?? []).toEqual([])
      expect(out.geometry?.p0?.[0]).toBeCloseTo(expected[0])
      expect(out.geometry?.p0?.[1]).toBeCloseTo(expected[1])
    }
  })

  it('fully constrains the Ex002 hole: centre coincident with the projected origin, plus a diameter', () => {
    if (!solveBytes) return
    const facePlane = { origin: [0, 0, 5], normal: [0, 0, 1], x_axis: [0, 1, 0], y_axis: [-1, 0, 0] }
    const feature: Dict = {
      id: 'sk1', kind: 'sketch', plane: '?face',
      entities: [{ id: 'c0', kind: 'circle' }, { id: 'p0', kind: 'point' }],
      initial: { c0: [3, 4, 3] },
      constraints: [
        { id: 'proj_p0', kind: 'projection', target: '$p0', source: '@builtin_origin' },
        { id: 'c_co', kind: 'coincident', a: { entity: 'c0', point: 'center' }, b: { entity: 'p0', point: 'xy' } },
        { id: 'c_dia', kind: 'diameter', target: '$c0', value: 6 },
      ],
    }
    const out = solveSketch(feature, repoOf({ builtin_origin: originPoint, '?face': facePlane }), {} as Record<string, Body>)
    expect(out.status).toBe('fully_constrained')
    expect(out.geometry?.c0?.[0]).toBeCloseTo(0)
    expect(out.geometry?.c0?.[1]).toBeCloseTo(0)
    expect(out.geometry?.c0?.[2]).toBeCloseTo(3)
  })
})

describe('solveSketch projects another sketch\'s whole entity', () => {
  beforeEach(() => {
    resetSketchSolver()
    if (solveBytes) setSketchSolver(solveBytes)
  })

  // sk1 lives on Front and holds a line from (0,0) to (5,5). In world space that
  // is (0,0,0)->(5,5,0); on a Right-plane sketch (local x = -world z, local y =
  // world y) it projects to (0,0)->(0,5).
  const front = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }

  const ENTRIES: Record<string, unknown> = {
    'sk1/L1': { external_params: [0, 0, 5, 5], kind: 'line', sketch_id: 'sk1' },
    'sk1/L1/start': { external_xy: [0, 0], sketch_id: 'sk1' },
    'sk1/L1/end': { external_xy: [5, 5], sketch_id: 'sk1' },
    _pt_sk1: front,
  }

  /** A repository over `entries`, keyed the way the slash registry stores them
   *  (`@` stripped), with the element map the frame lookup reads. */
  function repoOf(entries: Record<string, unknown> = ENTRIES): Repository {
    return {
      query: (q: string) => {
        const key = q.startsWith('@') ? q.slice(1) : q
        return (key in entries ? entries[key] : null) as never
      },
      elements: new Map<string, unknown>(Object.entries(entries)),
    } as unknown as Repository
  }

  const sketchWithProjection = (source: string, declaredKind: string): Dict => ({
    id: 'sk2', kind: 'sketch', plane: '@builtin_plane_right',
    entities: [{ id: 'held', kind: declaredKind }],
    initial: { held: declaredKind === 'point' ? [9, 9] : [0, 0, 1, 0] },
    constraints: [{ id: 'proj_held', kind: 'projection', target: '$held', source }],
  })

  it('lifts a foreign line through its owning sketch frame and projects it', () => {
    if (!solveBytes) return
    const out = solveSketch(sketchWithProjection('@sk1/L1', 'line'), repoOf(), {} as Record<string, Body>)
    expect(out.status).not.toBe('error')
    expect(out.projection_errors).toBeUndefined()
    const g = out.geometry?.held
    expect(g).toBeDefined()
    expect(g![0]).toBeCloseTo(0)
    expect(g![1]).toBeCloseTo(0)
    expect(g![2]).toBeCloseTo(0)
    expect(g![3]).toBeCloseTo(5)
  })

  it('keeps a foreign vertex projection working (the point path)', () => {
    if (!solveBytes) return
    const out = solveSketch(sketchWithProjection('@sk1/L1/end', 'point'), repoOf(), {} as Record<string, Body>)
    expect(out.projection_errors).toBeUndefined()
    expect(out.geometry?.held?.[0]).toBeCloseTo(0)
    expect(out.geometry?.held?.[1]).toBeCloseTo(5)
  })

  it('reports an unknown source as a projection error and a named warning', () => {
    if (!solveBytes) return
    const out = solveSketch(sketchWithProjection('@sk1/nope', 'point'), repoOf(), {} as Record<string, Body>)
    expect(out.projection_errors).toEqual(['proj_held'])
    expect(out.solver_warning).toContain(
      'projection proj_held source @sk1/nope did not resolve; the entity keeps its last position',
    )
  })

  it('reports a foreign spline source instead of projecting a wrong curve', () => {
    if (!solveBytes) return
    // This batch lowers line, circle and arc from another sketch; a spline (or
    // ellipse) source refuses, and the refusal is visible rather than silent.
    const entries = {
      ...ENTRIES,
      'sk1/S1': { external_params: [0, 0, 1, 1, 2, 2, 3, 3], kind: 'spline', sketch_id: 'sk1' },
    }
    const out = solveSketch(sketchWithProjection('@sk1/S1', 'spline'), repoOf(entries), {} as Record<string, Body>)
    expect(out.projection_errors).toEqual(['proj_held'])
  })
})

describe('solveSketch reports the constraints it could not use', () => {
  beforeEach(() => {
    resetSketchSolver()
    if (solveBytes) setSketchSolver(solveBytes)
  })

  // The reported document, rebuilt from the finding text: sk2 on the Right plane
  // carries a snap-authored coincident whose second operand is a line of sk1 on
  // the Front plane (`@sk1/1yxgoOAo0Q3Xondp`). The sketch is otherwise fully
  // constrained, so the dead row is the only thing the user could not find.
  it('lists a cross-sketch coincident as dropped and keeps the sketch fully constrained', () => {
    if (!solveBytes) return
    const feature: Dict = {
      id: 'sk2', kind: 'sketch', plane: '@builtin_plane_right',
      entities: [{ id: 'ax', kind: 'line' }],
      initial: { ax: [0, 0, 10, 0] },
      constraints: [
        { id: 'c_axstart_origin', kind: 'coincident', a: '$axstart', b: '@builtin_origin' },
        { id: 'c_ax_horiz', kind: 'horizontal', target: '$ax' },
        { id: 'c_ax_len', kind: 'length', target: '$ax', value: 10 },
        {
          id: 'c_coincident_oT6KcUj9', kind: 'coincident',
          a: '$axstart', b: '@sk1/1yxgoOAo0Q3Xondp',
        },
      ],
    }
    const out = solveSketch(feature, deadRepo(), {} as Record<string, Body>)
    expect(out.status).toBe('fully_constrained')
    expect(out.dropped_constraints).toEqual([
      { id: 'c_coincident_oT6KcUj9', kind: 'coincident', reason: 'stale reference' },
    ])
    // The plain warning channel keeps the same sentence the tree already shows.
    expect(out.solver_warning).toContain(
      'constraint c_coincident_oT6KcUj9 (coincident) names operands it cannot use (stale reference) and was ignored.',
    )
  })
})

describe('solveSketch pins projected entities (fix-projected-entities-pinned)', () => {
  beforeEach(() => {
    resetSketchSolver()
    if (solveBytes) setSketchSolver(solveBytes)
  })

  const projCircle: Dict = {
    type: 'edge', kind: 'circle', center: [3, 4, 0], radius: 5, axis: [0, 0, 1], x_axis: [1, 0, 0],
  }

  it('a. keeps a projected entity at its projected location alongside free geometry', () => {
    if (!solveBytes) return
    const feature: Dict = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [
        { id: 'c0', kind: 'circle' },
        { id: 'ln', kind: 'line' },  // underconstrained user line
      ],
      initial: { ln: [0, 0, 8, 1] },
      constraints: [
        { id: 'proj_c0', kind: 'projection', target: '$c0', source: '?edge;circle' },
      ],
    }
    const out = solveSketch(feature, stubRepo(projCircle), {} as Record<string, Body>)
    expect(out.status).not.toBe('error')
    const g = out.geometry?.c0
    expect(g![0]).toBeCloseTo(3)
    expect(g![1]).toBeCloseTo(4)
    expect(g![2]).toBeCloseTo(5)
  })

  it('b. a coincident to a user point is absorbed entirely by the user point, not the projection', () => {
    if (!solveBytes) return
    // Without the pin, the solver would split the DOF and drag the projected
    // circle toward the user point. Pinned, the circle holds and the user point
    // travels the whole way to the circle center.
    const feature: Dict = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [
        { id: 'c0', kind: 'circle' },
        { id: 'p0', kind: 'point' },
      ],
      initial: { p0: [10, 10] },
      constraints: [
        { id: 'proj_c0', kind: 'projection', target: '$c0', source: '?edge;circle' },
        { id: 'cc', kind: 'coincident', a: '$p0', b: '$c0center' },
      ],
    }
    const out = solveSketch(feature, stubRepo(projCircle), {} as Record<string, Body>)
    expect(out.status).not.toBe('error')
    // Projected circle did not move off (3,4) despite the coincident.
    expect(out.geometry?.c0?.[0]).toBeCloseTo(3)
    expect(out.geometry?.c0?.[1]).toBeCloseTo(4)
    // The user point absorbed all the movement, landing on the circle center.
    expect(out.geometry?.p0?.[0]).toBeCloseTo(3)
    expect(out.geometry?.p0?.[1]).toBeCloseTo(4)
  })

  it('c. re-solve is bit-identical for the projected entity (no convergence-by-re-solve)', () => {
    if (!solveBytes) return
    const feature: Dict = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [
        { id: 'c0', kind: 'circle' },
        { id: 'p0', kind: 'point' },
      ],
      initial: { p0: [10, 10] },
      constraints: [
        { id: 'proj_c0', kind: 'projection', target: '$c0', source: '?edge;circle' },
        { id: 'cc', kind: 'coincident', a: '$p0', b: '$c0center' },
      ],
    }
    const a = solveSketch(feature, stubRepo(projCircle), {} as Record<string, Body>)
    const b = solveSketch(feature, stubRepo(projCircle), {} as Record<string, Body>)
    expect(a.geometry?.c0).toEqual(b.geometry?.c0)
  })

  it('d. a drag preview keeps the projected entity pinned', () => {
    if (!solveBytes) return
    // The projected entity's last resolved params live in `initial`; the drag
    // path strips the projection and must still pin them so the dragged user
    // geometry cannot pull the projection along.
    const feature = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [
        { id: 'c0', kind: 'circle' },
        { id: 'ln', kind: 'line' },
      ],
      initial: { c0: [3, 4, 5], ln: [0, 0, 1, 0] },
      constraints: [
        { id: 'proj_c0', kind: 'projection', target: '$c0', source: '?edge;circle' },
        { id: 'cc', kind: 'coincident', a: '$lnend', b: '$c0center' },
      ],
    } as unknown as SketchFeature

    const ctx = prepareDragContext(feature, 'ln', null)
    expect(ctx).not.toBeNull()
    // The lowered drag input pins c0's three params (a non-empty mask proves it).
    expect(ctx!.input.pinnedMask.some((byte) => byte !== 0)).toBe(true)

    const delta: [number, number] = [6, 6]
    const result = solveSketchDrag(ctx!, ctx!.params0, delta, delta)
    expect(result).not.toBeNull()
    // c0 stayed at its projected location through the drag frame. The pin is a
    // soft least-squares residual (x[i]-x0[i]), not a hard lock, so a competing
    // coincident against the weighted drag anchor leaves a sub-0.1 residual --
    // versus the several-unit drift toward ln.end (~[7,6]) without any pin.
    const c0 = result!.geometry.c0
    expect(Math.hypot(c0[0] - 3, c0[1] - 4)).toBeLessThan(0.1)
    expect(c0[2]).toBeCloseTo(5, 1)
  })

  it('e. adopts the last solve resolved kind in the drag preview and probe', () => {
    if (!solveBytes) return
    // A browser document keeps the pick-time kind while the solve bakes the
    // resolved one: a projected circle seen edge-on stores `circle` with the
    // lowered 4-param line. The drag preview and the authoring probe read
    // `initial` directly with no repository to re-lower from, so they must be
    // told the resolved kind or the 4 params are read as a circle.
    const feature = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'pc', kind: 'circle' }, { id: 'p0', kind: 'point' }],
      initial: { pc: [0, -1, 0, 1], p0: [10, 10] },
      constraints: [
        { id: 'proj_pc', kind: 'projection', target: '$pc', source: '?edge;circle' },
        { id: 'cc', kind: 'coincident', a: '$p0xy', b: '$pccenter' },
      ],
    } as unknown as SketchFeature

    const stale = prepareDragContext(feature, 'p0', 'xy', [0, 0])
    expect(stale).not.toBeNull()
    expect(stale!.layout.find(e => e.id === 'pc')).toMatchObject({ kind: 'circle', size: 3 })

    const adopted = prepareDragContext(feature, 'p0', 'xy', [0, 0], { pc: 'line' })
    expect(adopted).not.toBeNull()
    expect(adopted!.layout.find(e => e.id === 'pc')).toMatchObject({ kind: 'line', size: 4 })

    expect(pinProjectionTargets(feature, { pc: 'line' }).loweredFeature.entities
      ?.find(e => e.id === 'pc')?.kind).toBe('line')
    // Without the resolved kinds the stored feature is returned untouched.
    expect(pinProjectionTargets(feature).loweredFeature).toBe(feature)
  })
})
