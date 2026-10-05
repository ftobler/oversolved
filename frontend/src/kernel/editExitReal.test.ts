// @vitest-environment node
//
// Edit-exit rebuild tests: changing a feature parameter must trigger downstream
// rebuild. Ports test_builder_edit_exit_rebuild.py.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './occ/loadOcc'
import { SharedHarness } from './occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from './features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketch(sketchId: string, w: number, h: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane: '@builtin_plane_front',
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

describe.skipIf(!oc || !solveBytes)('edit exit rebuild (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  it('edit exit rebuild, downstream features re-solved after param edit', () => {
    /**
     * sk1 -> ex1 -> fillet: mutate ex1 distance, rebuild full, downstream fillet
     * must be re-solved and still produce valid output.
     */
    // Build without the fillet first to take a construction-UUID edge query off
    // the extrude; that identity is restored across the parameter edit, unlike
    // a legacy index query.
    const probe = h.run({ features: [
      rectSketch('sk1', 10, 10),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, direction: 'normal' },
    ]})
    const edges = (h.body(probe, 'body_ex1').edge_queries as string[]) ?? []
    const filletEdge = edges.find((q) => q.includes('@u|')) ?? edges[0]
    expect(filletEdge).toBeTruthy()

    const spec = { features: [
      rectSketch('sk1', 10, 10),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, direction: 'normal' },
      { id: 'fil1', kind: 'fillet', edges: [filletEdge], radius: 0.5 },
    ]}
    const r1 = h.run(spec)
    expect(h.res(r1, 'fil1').status).toBe('ok')

    const spec2 = { features: [
      rectSketch('sk1', 10, 10),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 8, direction: 'normal' },
      { id: 'fil1', kind: 'fillet', edges: [filletEdge], radius: 0.5 },
    ]}
    const r2 = h.run(spec2, { prevState: r1._build_state })
    // The downstream fillet must be re-solved, not carried over as a stale ok:
    // its checkpoint result is a fresh object from this build.
    expect(h.res(r2, 'fil1').status).toBe('ok')
    expect(r2._build_state.checkpoints.fil1?.result).toBeDefined()
    expect(r2._build_state.checkpoints.fil1?.result).not.toBe(
      r1._build_state.checkpoints.fil1?.result,
    )
    expect(r2.bodies).toHaveProperty('body_ex1')
  })
})
