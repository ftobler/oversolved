// @vitest-environment node
//
// Integration: solveSketch lowers a projected entity through the real Rust WASM
// solver. Guards the params-into-`initial` fix -- without it a projected entity
// solves to the origin instead of its projected location -- and the tilted
// circle -> ellipse kind promotion (full-brep-projection).
import { describe, it, expect, beforeEach } from 'vitest'
import {
  solveSketch, setSketchSolver, resetSketchSolver,
  prepareDragContext, solveSketchDrag,
} from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { worldToSketch2d } from '../shared/planes'
import type { Repository } from '../../query'
import type { Body } from '../../types3d'
import type { SketchFeature } from '@/types/cad'

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
      entities: [{ id: 'c0', kind: 'circle', source: '?edge;circle' }],
      initial: {},
      constraints: [],
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
      entities: [{ id: 'e0', kind: 'circle', source: '?edge;circle' }],
      initial: {},
      constraints: [],
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

  it('surfaces resolved_kinds=spline for a partial elliptical edge (declared ellipse)', () => {
    if (!solveBytes) return
    const partialEllipse: Dict = {
      type: 'edge', kind: 'ellipse', center: [0, 0, 0], a: 4, b: 2,
      axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI / 2,
    }
    const feature: Dict = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'ell0', kind: 'ellipse', source: '?edge;ellipse' }],
      initial: {},
      constraints: [],
    }
    const out = solveSketch(feature, stubRepo(partialEllipse), {} as Record<string, Body>)
    expect(out.status).not.toBe('error')
    // 8 params => lowered to a spline; the doc entity must adopt 'spline' or a
    // declared-'ellipse' entity renders 8 spline numbers as [cx,cy,a,b,theta].
    expect(out.geometry?.ell0).toHaveLength(8)
    expect(out.resolved_kinds?.ell0).toBe('spline')
  })

  it('converges: a doc entity already adopted as spline re-solves from an ellipse source', () => {
    if (!solveBytes) return
    // Second solve after convergence: the doc entity kind is now 'spline' (it
    // adopted the resolved kind last solve) but its source edge is still an
    // ellipse. Projection must branch on the resolved geometry, not the declared
    // kind, or the spline branch reads a non-existent points array and fails.
    const partialEllipse: Dict = {
      type: 'edge', kind: 'ellipse', center: [0, 0, 0], a: 4, b: 2,
      axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI / 2,
    }
    const feature: Dict = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'ell0', kind: 'spline', source: '?edge;ellipse' }],
      initial: {},
      constraints: [],
    }
    const out = solveSketch(feature, stubRepo(partialEllipse), {} as Record<string, Body>)
    expect(out.status).not.toBe('error')
    expect(out.geometry?.ell0).toHaveLength(8)
    expect(out.resolved_kinds).toBeUndefined()  // already spline -> no further change
  })

  it('drops an unresolvable projection and still solves the rest of the sketch', () => {
    if (!solveBytes) return
    // A stale projection (source no longer resolves) must NOT throw the whole
    // sketch -- it is dropped, the user's own geometry still solves, and the
    // dropped id is reported. Regression for "the whole sketch went inert".
    const feature: Dict = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [
        { id: 'drawn', kind: 'circle' },
        { id: 'stale', kind: 'ellipse', source: '?edge;gone' },
      ],
      initial: { drawn: [2, 3, 4] },
      constraints: [],
    }
    const out = solveSketch(feature, deadRepo(), {} as Record<string, Body>)
    expect(out.status).not.toBe('exception')
    expect(out.status).not.toBe('error')
    // The drawn circle solved and renders.
    expect(out.geometry?.drawn).toBeDefined()
    expect(out.geometry?.drawn?.[2]).toBeCloseTo(4)
    // The stale projection stays pinned at its cached/default params and is reported.
    expect(out.geometry?.stale).toBeDefined()
    expect(out.projection_errors).toContain('proj_stale')
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
      entities: [{ id: 'c0', kind: 'circle', source: '?edge;circle' }],
      initial: {},
      constraints: [],
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
      entities: [{ id: 'a0', kind: 'arc', source: '?edge;arc' }],
      initial: {},
      constraints: [],
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
        { id: 'c0', kind: 'circle', source: '?edge;circle' },
        { id: 'ln', kind: 'line' },  // underconstrained user line
      ],
      initial: { ln: [0, 0, 8, 1] },
      constraints: [],
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
        { id: 'c0', kind: 'circle', source: '?edge;circle' },
        { id: 'p0', kind: 'point' },
      ],
      initial: { p0: [10, 10] },
      constraints: [{ id: 'cc', kind: 'coincident', a: '$p0', b: '$c0center' }],
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
        { id: 'c0', kind: 'circle', source: '?edge;circle' },
        { id: 'p0', kind: 'point' },
      ],
      initial: { p0: [10, 10] },
      constraints: [{ id: 'cc', kind: 'coincident', a: '$p0', b: '$c0center' }],
    }
    const a = solveSketch(feature, stubRepo(projCircle), {} as Record<string, Body>)
    const b = solveSketch(feature, stubRepo(projCircle), {} as Record<string, Body>)
    expect(a.geometry?.c0).toEqual(b.geometry?.c0)
  })

  it('d. a drag preview keeps the projected entity pinned', () => {
    if (!solveBytes) return
    // The projected entity's last resolved params live in `initial`; the drag
    // path strips `source` and must still pin them so the dragged user geometry
    // cannot pull the projection along.
    const feature = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [
        { id: 'c0', kind: 'circle', source: '?edge;circle' },
        { id: 'ln', kind: 'line' },
      ],
      initial: { c0: [3, 4, 5], ln: [0, 0, 1, 0] },
      constraints: [{ id: 'cc', kind: 'coincident', a: '$lnend', b: '$c0center' }],
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
})
