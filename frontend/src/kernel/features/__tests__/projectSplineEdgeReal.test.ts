// @vitest-environment node
//
// Reproduces the reported bug: a body spline edge never projects into a sketch.
// A Bezier-capped profile is extruded, then its top spline edge is projected into
// a second Top sketch -- the exact source the project tool hands over as the
// picked edge query. The projection must resolve to that cubic instead of
// warning and leaving an all-zero curve at the sketch origin.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'

const oc = await loadOcc()
const solveBytes = loadSolver()

/** Distance between two 2D points, for the fit tolerances below. */
function d2(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

function splineCapSketch(sketchId: string) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Bezier cap',
    plane: '@builtin_plane_top',
    entities: [
      { id: 'curve', kind: 'spline' as const },
      { id: 'base', kind: 'line' as const },
    ],
    // The arch cubic of the bug report, closed by its chord.
    initial: {
      curve: [0, 0, 3, 6, 7, 6, 10, 0],
      base: [10, 0, 0, 0],
    },
    constraints: [
      {
        id: 'j1', kind: 'coincident' as const,
        a: { entity: 'curve', point: 'start' as const },
        b: { entity: 'base', point: 'end' as const },
      },
      {
        id: 'j2', kind: 'coincident' as const,
        a: { entity: 'curve', point: 'end' as const },
        b: { entity: 'base', point: 'start' as const },
      },
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('project a body spline edge into a sketch (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  it('projects the extruded cubic cap as that cubic, with no projection warning', () => {
    const sk1 = splineCapSketch('sk1')
    const ex1 = { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, direction: 'normal', operation: 'new' }
    const r1 = h.run({ features: [sk1, ex1] })
    expect(h.res(r1, 'ex1').status).toBe('ok')

    const body = h.body(r1, 'body_ex1')
    const edges = (body.edges as Array<{ kind?: string; points?: number[][] }>) ?? []
    const queries = (body.edge_queries as string[]) ?? []
    expect(queries.length).toBe(edges.length)
    // The extruded cap (Top's normal is +Y, so the far cap sits at |y| = 5): a
    // sampled spline edge, exactly what the picker hands the project tool as a
    // `?..:edge` source.
    const topSpline = edges.findIndex(
      (ed) => ed.kind === 'spline' && ed.points !== undefined && Math.abs(Math.abs(ed.points[0][1]) - 5) < 1e-6,
    )
    expect(topSpline).toBeGreaterThanOrEqual(0)

    const sk2 = {
      id: 'sk2', kind: 'sketch' as const, plane: '@builtin_plane_top',
      entities: [{ id: 'proj0', kind: 'spline' as const, source: queries[topSpline] }],
      initial: {},
      constraints: [],
    }
    const r2 = h.run({ features: [sk1, ex1, sk2] }, { prevState: r1._build_state })
    const res = h.res(r2, 'sk2')
    expect(res.status).not.toBe('exception')
    expect(res.status).not.toBe('error')
    expect((res.projection_errors as string[]) ?? []).toEqual([])
    expect((res.solver_warning as string) ?? '').not.toContain('did not resolve')

    const g = ((res.geometry as Record<string, number[]> | undefined) ?? {}).proj0
    expect(g).toBeDefined()
    expect(g).toHaveLength(8)
    // The extruded cap is that same cubic in the Top sketch's coordinates: the
    // ends are its chord ends and the controls its arch handles.
    const ends = [g!.slice(0, 2), g!.slice(6, 8)]
    expect(ends.some((p) => d2(p, [0, 0]) < 5e-3)).toBe(true)
    expect(ends.some((p) => d2(p, [10, 0]) < 5e-3)).toBe(true)
    const controls = [g!.slice(2, 4), g!.slice(4, 6)]
    expect(controls.some((p) => d2(p, [3, 6]) < 0.1)).toBe(true)
    expect(controls.some((p) => d2(p, [7, 6]) < 0.1)).toBe(true)
  })
})
