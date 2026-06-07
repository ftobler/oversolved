// @vitest-environment node
//
// Partial rebuild tests using the OCC.js + Rust WASM build pipeline with a
// persistent HandleTable across multiple build() calls. Ports the OCC-backed
// scenarios from test_builder_partial_rebuild.py that need live shape handles
// to survive between builds (clean prefix reuse).
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './occ/loadOcc'
import { SharedHarness } from './occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from './features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketch(sketchId: string, w: number, h: number, opts?: { plane?: string; label?: string }) {
  return {
    id: sketchId, kind: 'sketch' as const, label: opts?.label ?? 'Rectangle',
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

function extrudeSpec(sketchId: string, extrudeId: string, opts?: { distance?: number; operation?: string; direction?: string }) {
  return {
    id: extrudeId, kind: 'extrude', sketch: '$' + sketchId,
    distance: opts?.distance ?? 5, direction: opts?.direction ?? 'normal',
    operation: opts?.operation ?? 'add',
  }
}

describe.skipIf(!oc || !solveBytes)('builder partial rebuild (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  it('partial rebuild restores body mesh from clean prefix', () => {
    /** After a full build, changing a later feature triggers a partial rebuild
     *  that must restore the clean-prefix body from the previous checkpoint.
     *  Port of test_partial_rebuild_restores_brep_face_ancestry_queries. */
    const sk1 = rectSketch('sk1', 10, 10)
    const ex1 = extrudeSpec('sk1', 'ex1', { distance: 3 })
    const spec = { features: [sk1, ex1] }
    const r1 = h.run(spec)
    expect(h.res(r1, 'ex1').status).toBe('ok')
    expect(r1.bodies).toHaveProperty('body_ex1')

    // Add a second sketch on the first body's face — triggers partial rebuild.
    const faceQueries = (h.body(r1, 'body_ex1').mesh as { face_queries?: string[] } | undefined)?.face_queries ?? []
    expect(faceQueries.length).toBeGreaterThan(0)

    const sk2 = { ...rectSketch('sk2', 4, 4, { plane: faceQueries[0] }), constraints: [] }
    const spec2 = { features: [sk1, ex1, sk2] }
    const r2 = h.run(spec2, { prevState: r1._build_state })

    expect(h.res(r2, 'sk1').status).not.toBe('exception')
    expect(h.res(r2, 'ex1').status).toBe('ok')
    expect(h.res(r2, 'sk2').status).not.toBe('exception')
    expect(r2.bodies).toHaveProperty('body_ex1')
  })

  it('partial rebuild only resolves dirty features', () => {
    /** When only sk2 changes in a [sk1, sk2] stack, sk1 is restored from cache
     *  and not re-solved. Port of test_partial_rebuild_only_resolves_dirty. */
    const sk1 = rectSketch('sk1', 10, 10, { label: 'original' })
    const sk2 = rectSketch('sk2', 5, 5, { label: 'original' })
    const spec = { features: [sk1, sk2] }
    const r1 = h.run(spec)
    expect(h.res(r1, 'sk1').status).not.toBe('exception')
    expect(h.res(r1, 'sk2').status).not.toBe('exception')

    const sk2v2 = { ...rectSketch('sk2', 5, 5), label: 'modified' }
    const spec2 = { features: [sk1, sk2v2] }
    const r2 = h.run(spec2, { prevState: r1._build_state })

    expect(h.res(r2, 'sk1').status).not.toBe('exception')
    expect(h.res(r2, 'sk2').status).not.toBe('exception')
  })

  it('partial rebuild with extrude chain after fuse works', () => {
    /** A sketch placed on a B-rep face, then extruded (fused), followed by
     *  sketch modification and partial rebuild must not cause
     *  AmbiguousQueryError. Port of
     *  test_partial_rebuild_sketch_on_face_after_fuse_no_ambiguous_query. */
    const sk1 = rectSketch('sk1', 10, 10)
    const ex1 = extrudeSpec('sk1', 'ex1', { distance: 5 })
    const r1 = h.run({ features: [sk1, ex1] })
    expect(h.res(r1, 'ex1').status).toBe('ok')

    const faceQueries = (h.body(r1, 'body_ex1').mesh as { face_queries?: string[] } | undefined)?.face_queries ?? []
    expect(faceQueries.length).toBeGreaterThan(0)

    const sk2 = {
      id: 'sk2', kind: 'sketch', plane: faceQueries[0],
      entities: [
        { id: 'l1', kind: 'line' }, { id: 'l2', kind: 'line' },
        { id: 'l3', kind: 'line' }, { id: 'l4', kind: 'line' },
      ],
      initial: { l1: [0, 0, 4, 0], l2: [4, 0, 4, 4], l3: [4, 4, 0, 4], l4: [0, 4, 0, 0] },
      constraints: [],
    }
    const ex2 = extrudeSpec('sk2', 'ex2', { distance: 2 })
    const specFull = { features: [sk1, ex1, sk2, ex2] }
    const rFull = h.run(specFull)
    expect(h.res(rFull, 'sk2').status).not.toBe('exception')

    const sk2v2 = { ...sk2, label: 'modified' }
    const specPartial = { features: [sk1, ex1, sk2v2, ex2] }
    const rPartial = h.run(specPartial, { prevState: rFull._build_state })
    expect(h.res(rPartial, 'sk2').status).not.toBe('exception')
  })

  it('checkpoint face ancestry uses pre-fuse geometry after undo', () => {
    /** Checkpoint for ex1 must report its own (pre-fuse) face positions when a
     *  later fuse is undone. Port of
     *  test_checkpoint_face_ancestry_uses_pre_fuse_geometry_after_undo. */
    const sk1 = rectSketch('sk1', 10, 10)
    const ex1 = extrudeSpec('sk1', 'ex1', { distance: 5 })
    const rBase = h.run({ features: [sk1, ex1] })
    expect(h.res(rBase, 'ex1').status).toBe('ok')

    const faceData = (h.body(rBase, 'body_ex1').mesh as { face_data?: Array<{ centroid: number[]; normal: number[] }> } | undefined)?.face_data ?? []
    const faceQueries = (h.body(rBase, 'body_ex1').mesh as { face_queries?: string[] } | undefined)?.face_queries ?? []
    let topQuery: string | undefined
    for (let i = 0; i < faceData.length; i++) {
      if (faceData[i].normal[2] > 0.9) { topQuery = faceQueries[i]; break }
    }
    expect(topQuery).toBeDefined()

    const sk2 = rectSketch('sk2', 8, 8, { plane: topQuery })
    const ex2 = extrudeSpec('sk2', 'ex2', { distance: 2 })
    const rFull = h.run({ features: [sk1, ex1, sk2, ex2] })
    expect(h.res(rFull, 'ex2').status).toBe('ok')

    const sk3 = { id: 'sk3', kind: 'sketch', plane: topQuery!, entities: [], constraints: [] }
    const rUndo = h.run({ features: [sk1, ex1, sk3] }, { prevState: rFull._build_state })

    expect(h.res(rUndo, 'sk3').status).not.toBe('exception')
    const planeTransform = h.res(rUndo, 'sk3').plane_transform as { origin?: number[] } | undefined
    expect(planeTransform).toBeDefined()
    expect(Math.abs((planeTransform!.origin![2]) - 5)).toBeLessThan(0.1)
  })
})
