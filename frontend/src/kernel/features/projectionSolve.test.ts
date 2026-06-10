// @vitest-environment node
//
// Integration: solveSketch lowers a projected entity through the real Rust WASM
// solver. Guards the params-into-`initial` fix -- without it a projected entity
// solves to the origin instead of its projected location -- and the tilted
// circle -> ellipse kind promotion (full-brep-projection).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { solveSketch, setSketchSolver, resetSketchSolver } from './sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import type { Repository } from '../query'
import type { Body } from '../types3d'

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
    expect(g![2]).toBeCloseTo(5)              // a = R
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
})
