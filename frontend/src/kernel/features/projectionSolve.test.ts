// @vitest-environment node
//
// Integration: solveSketch lowers a projected entity through the real Rust WASM
// solver. Guards the params-into-`initial` fix -- without it a projected entity
// solves to the origin instead of its projected location -- and the tilted
// circle -> ellipse kind promotion (full-brep-projection).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import {
  solveSketch, setSketchSolver, resetSketchSolver,
  prepareDragContext, solveSketchDrag,
} from './sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import type { Repository } from '../query'
import type { Body } from '../types3d'
import type { PartFeature } from '@/types/cad'

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
  beforeAll(() => {
    if (!solveBytes) return
  })
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
    // The stale projection was dropped (no geometry) and reported.
    expect(out.geometry?.stale).toBeUndefined()
    expect(out.projection_errors).toContain('stale')
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
    } as unknown as PartFeature

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
