// @vitest-environment node
//
// Checkpoint mesh behavior using the OCC.js + Rust WASM build pipeline with a
// persistent HandleTable. Exercises the cross-solve checkpoint / bodies_snapshot
// scenarios (ported from the retired Python suite).
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { SharedHarness } from '../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketch(sketchId: string, w: number, h: number, opts?: { plane?: string; initial?: Record<string, number[]> }) {
  const plane = opts?.plane ?? '@builtin_plane_front'
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane,
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: opts?.initial ?? {
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

function extrudeSpec(sketchId: string, extrudeId: string, opts?: { distance?: number; operation?: string }): Record<string, unknown> {
  return {
    id: extrudeId, kind: 'extrude', sketch: '$' + sketchId,
    distance: opts?.distance ?? 5, direction: 'normal',
    operation: opts?.operation ?? 'add',
  }
}

describe.skipIf(!oc || !solveBytes)('checkpoint meshing across builds (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  it('incremental build after last-feature edit produces valid output', () => {
    /** Editing only the last feature triggers an incremental (partial) rebuild:
     *  sk1..ex2 are the clean prefix restored from checkpoints, only ex3 is
     *  re-solved. All features must still produce ok status and valid meshes.
     *  Stage 7e: restored to the real partial-rebuild form (was dodged to a full
     *  rebuild during Stage 6). */
    const spec = { features: [
      rectSketch('sk1', 10, 10),
      extrudeSpec('sk1', 'ex1', { distance: 5 }),
      rectSketch('sk2', 5, 5, { plane: '@builtin_plane_right' }),
      extrudeSpec('sk2', 'ex2', { distance: 3 }),
      { id: 'ex3', kind: 'extrude', sketch: '$sk1', distance: 2, direction: 'normal', operation: 'new' },
    ]}

    const r1 = h.run(spec)
    expect(h.res(r1, 'ex3').status).toBe('ok')

    spec.features[4] = extrudeSpec('sk1', 'ex3', { distance: 4 })
    const r2 = h.run(spec, { prevState: r1._build_state })

    expect(h.res(r2, 'ex1').status).toBe('ok')
    expect(h.res(r2, 'ex3').status).toBe('ok')
    expect(r2.bodies).toHaveProperty('body_ex1')
  })

  it('fillet edit incremental rebuild produces valid output', () => {
    // Incremental rebuild after fillet radius edit must work.
    const spec = { features: [
      rectSketch('sk1', 10, 10),
      extrudeSpec('sk1', 'ex1', { distance: 5 }),
    ]}
    const r0 = h.run(spec)
    const eq = (h.body(r0, 'body_ex1').edge_queries as string[]) ?? []
    expect(eq.length).toBeGreaterThan(0)

    spec.features.push({ id: 'fi1', kind: 'fillet', edges: [eq[0]], radius: 0.5 })
    const r1 = h.run(spec)
    expect(h.res(r1, 'fi1').status).toBe('ok')

    const r2 = h.run(
      { features: [spec.features[0], spec.features[1], { id: 'fi1', kind: 'fillet', edges: [eq[0]], radius: 1 }] },
      { prevState: r1._build_state },
    )
    expect(h.res(r2, 'fi1').status).toBe('ok')
    expect(r2.bodies).toHaveProperty('body_ex1')
  })

  it('pick_bodies served from checkpoint', () => {
    // pick_bodies must be present and populated from checkpoint snapshots.
    const spec = { features: [
      rectSketch('sk1', 10, 10),
      extrudeSpec('sk1', 'ex1', { distance: 5 }),
      rectSketch('sk2', 5, 5, { plane: '@builtin_plane_right' }),
      extrudeSpec('sk2', 'ex2', { distance: 3 }),
    ]}
    const r1 = h.run(spec)

    const lastFid = r1._build_state!.feature_order[r1._build_state!.feature_order.length - 1]
    const lastCp = r1._build_state!.checkpoints[lastFid]
    expect(Object.keys(lastCp.bodies_snapshot ?? {}).length).toBeGreaterThan(0)

    spec.features[1] = extrudeSpec('sk1', 'ex1', { distance: 6 })
    const r2 = h.run(spec, { prevState: r1._build_state, pickBoundary: 2 })
    expect(r2.pick_bodies).toBeDefined()
  })

  it('upstream edit incremental rebuild produces valid output', () => {
    /**
     * Editing feature 0 (first_dirty==0) triggers a full rebuild via the incremental path. All
     * features must still be ok.
     */
    const spec = { features: [
      rectSketch('sk1', 10, 10),
      extrudeSpec('sk1', 'ex1', { distance: 5 }),
      rectSketch('sk2', 5, 5, { plane: '@builtin_plane_right' }),
      extrudeSpec('sk2', 'ex2', { distance: 3 }),
    ]}
    const r1 = h.run(spec)

    spec.features[0] = rectSketch('sk1', 15, 10, {
      initial: { bottom: [0, 0, 15, 0], right: [15, 0, 15, 10], top: [15, 10, 0, 10], left: [0, 10, 0, 0] },
    })
    const r2 = h.run(spec, { prevState: r1._build_state })

    expect(h.res(r2, 'ex1').status).toBe('ok')
    expect(h.res(r2, 'ex2').status).toBe('ok')
    expect(r2.bodies).toHaveProperty('body_ex1')
  })
})
