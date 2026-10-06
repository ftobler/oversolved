// @vitest-environment node
//
// Reproduces the reported bug: "picking an edge on the project tool seems
// currently impossible". Builds sketch -> extrude (a body with pickable edges)
// -> a second sketch that projects one of the body's edges via the same
// edge_query the picker hands to the project tool. The projected entity must
// resolve through the live globalRepo and gain geometry, not be silently
// dropped into projection_errors.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'

const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketch(sketchId: string, w: number, h: number, opts?: { plane?: string }) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle',
    plane: opts?.plane ?? '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [0, 0, w, 0], right: [w, 0, w, h],
      top: [w, h, 0, h], left: [0, h, 0, 0],
    },
    constraints: [
      { id: 'c1', kind: 'coincident' as const, a: { entity: 'bottom', point: 'end' as const }, b: { entity: 'right', point: 'start' as const } },
      { id: 'c2', kind: 'coincident' as const, a: { entity: 'right', point: 'end' as const }, b: { entity: 'top', point: 'start' as const } },
      { id: 'c3', kind: 'coincident' as const, a: { entity: 'top', point: 'end' as const }, b: { entity: 'left', point: 'start' as const } },
      { id: 'c4', kind: 'coincident' as const, a: { entity: 'left', point: 'end' as const }, b: { entity: 'bottom', point: 'start' as const } },
      { id: 'c5', kind: 'horizontal' as const, target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal' as const, target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical' as const, target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical' as const, target: { entity: 'left' } },
      { id: 'c9', kind: 'length' as const, target: { entity: 'bottom' }, value: w },
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: h },
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('project a body edge into a sketch (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  it('a projected body edge resolves to geometry and is not dropped', () => {
    const sk1 = rectSketch('sk1', 10, 10)
    const ex1 = { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, direction: 'normal', operation: 'add' }
    const r1 = h.run({ features: [sk1, ex1] })
    expect(h.res(r1, 'ex1').status).toBe('ok')

    // The exact edge_queries the picker registers in the edge ID layer and hands
    // to the project tool as hoveredSelectionId.
    const edgeQueries = (h.body(r1, 'body_ex1').edge_queries as string[]) ?? []
    expect(edgeQueries.length).toBeGreaterThan(0)
    const edgeSource = edgeQueries[0]
    // straightedge -> drawLogic lowers it to a 'line' projected entity.
    const sk2 = {
      id: 'sk2', kind: 'sketch' as const, plane: '@builtin_plane_front',
      entities: [{ id: 'proj0', kind: 'line' as const, source: edgeSource }],
      initial: {},
      constraints: [],
    }
    const r2 = h.run({ features: [sk1, ex1, sk2] }, { prevState: r1._build_state })

    const sk2res = h.res(r2, 'sk2')
    expect(sk2res.status).not.toBe('exception')
    expect(sk2res.status).not.toBe('error')

    const projErrors = (sk2res.projection_errors as string[]) ?? []
    const geometry = (sk2res.geometry as Record<string, number[]>) ?? {}
    // The whole point: the picked edge must resolve, not be dropped.
    expect(projErrors).not.toContain('proj0')
    expect(geometry.proj0).toBeDefined()
  })
})
