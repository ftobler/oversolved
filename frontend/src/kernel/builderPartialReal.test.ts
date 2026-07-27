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
import importFixture from './occ/__fixtures__/importStep.json'
const oc = await loadOcc()
const solveBytes = loadSolver()
const importFx = importFixture as unknown as { file_data: string }

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
    /**
     * After a full build, changing a later feature triggers a partial rebuild that must restore
     * the clean-prefix body from the previous checkpoint.
     */
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
    /**
     * When only sk2 changes in a [sk1, sk2] stack, sk1 is restored from cache and not
     * re-solved.
     */
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
    /**
     * A sketch placed on a B-rep face, then extruded (fused), followed by sketch modification
     * and partial rebuild must not cause AmbiguousQueryError.
     */
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
    /**
     * Checkpoint for ex1 must report its own (pre-fuse) face positions when a later fuse is
     * undone.
     */
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

  it('body addition in dirty range succeeds', () => {
    /** Insert a new sketch between sk1 and ex1; ex1 is re-solved but still ok. */
    const sk1 = rectSketch('sk1', 5, 3)
    const ex1 = extrudeSpec('sk1', 'ex1', { distance: 5 })
    const spec = { features: [sk1, ex1] }
    const r1 = h.run(spec)

    const newSk = rectSketch('sk_insert', 3, 2)
    const spec2 = { features: [sk1, newSk, ex1] }
    const r2 = h.run(spec2, { prevState: r1._build_state })

    expect(h.res(r2, 'ex1').status).toBe('ok')
  })

  it('partial rebuild preserves shape identity', () => {
    /** After partial rebuild, unchanged feature's body.shape is the same handle. */
    const sk1 = rectSketch('sk1', 5, 3)
    const ex1 = extrudeSpec('sk1', 'ex1', { distance: 5 })
    const spec = { features: [sk1, ex1] }
    const r1 = h.run(spec)
    const shape1 = r1._build_state!.checkpoints['ex1'].body_store_snapshot['body_ex1'].shape

    const sk2 = rectSketch('sk2', 2, 2)
    const spec2 = { features: [sk1, ex1, sk2] }
    const r2 = h.run(spec2, { prevState: r1._build_state })
    const shape2 = r2._build_state!.checkpoints['ex1'].body_store_snapshot['body_ex1'].shape

    expect(shape1).toBe(shape2)
  })

  it('inserting a feature mid-stack triggers rebuild of later features', () => {
    /** [sk1, ex1] → [sk1, ex1, sk2, ex2] via PARTIAL rebuild (prevState): sk1+ex1
     *  are the clean prefix restored from the ex1 checkpoint, sk2/ex2 are the
     *  dirty tail. sk2's plane is a `@u|` face query captured from ex1's prior
     *  mesh, so it must resolve against the checkpoint-restored repo (Stage 7e:
     *  the byUuid map round-trips through the checkpoint snapshot, so the UUID
     *  tier resolves it exactly as on a full rebuild). */
    const sk1 = rectSketch('sk1', 10, 10)
    const ex1 = extrudeSpec('sk1', 'ex1', { distance: 5 })
    const r1 = h.run({ features: [sk1, ex1] })

    const faceQueries = (h.body(r1, 'body_ex1').mesh as { face_queries?: string[] } | undefined)?.face_queries ?? []
    expect(faceQueries.length).toBeGreaterThan(0)

    const planeQuery = faceQueries.find((q) => q.includes('@u|')) ?? faceQueries[0]
    expect(planeQuery).toContain('@u|')  // partial-rebuild resolution rides the UUID tier

    const sk2 = { ...rectSketch('sk2', 4, 4, { plane: planeQuery }), constraints: [] }
    const ex2 = extrudeSpec('sk2', 'ex2', { distance: 2 })
    const r2 = h.run({ features: [sk1, ex1, sk2, ex2] }, { prevState: r1._build_state })

    expect(h.res(r2, 'sk1').status).not.toBe('exception')
    expect(h.res(r2, 'ex1').status).toBe('ok')
    expect(h.res(r2, 'sk2').status).not.toBe('exception')
    expect(h.res(r2, 'ex2').status).toBe('ok')
  })

  it('partial rebuild resolves a @u| face query to the SAME face as a full rebuild', () => {
    /** Stage 7e guard: a face query inserted from a prior build's mesh must
     *  resolve identically whether the referenced body is freshly built (full
     *  rebuild) or restored from a checkpoint (partial rebuild). Also exercises
     *  the production boundary: prevState survives a structured-clone (JSON)
     *  round-trip before the partial rebuild, so the persisted `byUuid` map is
     *  what answers the query. */
    const sk1 = rectSketch('sk1', 10, 10)
    const ex1 = extrudeSpec('sk1', 'ex1', { distance: 5 })
    const r0 = h.run({ features: [sk1, ex1] })
    const faceQueries = (h.body(r0, 'body_ex1').mesh as { face_queries?: string[] } | undefined)?.face_queries ?? []
    const planeQuery = faceQueries.find((q) => q.includes('@u|'))
    expect(planeQuery).toBeDefined()

    const sk2 = { ...rectSketch('sk2', 4, 4, { plane: planeQuery! }), constraints: [] }

    // Full rebuild: reference body built fresh in the same build.
    const rFull = h.run({ features: [sk1, ex1, sk2] })
    const fullOrigin = (h.res(rFull, 'sk2').plane_transform as { origin?: number[] } | undefined)?.origin
    expect(fullOrigin).toBeDefined()

    // Partial rebuild: reference body restored from a JSON-serialized checkpoint.
    const restored = JSON.parse(JSON.stringify(r0._build_state)) as typeof r0._build_state
    const rPart = h.run({ features: [sk1, ex1, sk2] }, { prevState: restored })
    expect(h.res(rPart, 'sk2').status).not.toBe('exception')
    const partOrigin = (h.res(rPart, 'sk2').plane_transform as { origin?: number[] } | undefined)?.origin

    // Same face, not merely "some face": the checkpoint-restored repo must not
    // silently resolve to the wrong element (fail-safe > fail-wrong).
    expect(partOrigin).toEqual(fullOrigin)
  })

  it('reusing state does not duplicate brep face ancestry', () => {
    /** Rebuilding from the same cached state twice must not duplicate face ancestry entries. */
    const spec = { features: [rectSketch('sk1', 10, 10), extrudeSpec('sk1', 'ex1', { distance: 5 })] }
    const r1 = h.run(spec)
    const r2 = h.run(spec, { prevState: r1._build_state })
    const r3 = h.run(spec, { prevState: r2._build_state })

    const ckp = r3._build_state!.checkpoints['ex1']
    const snapshot = ckp.repo_snapshot as Record<string, unknown>
    const ancestral = snapshot.ancestral as Record<string, { set: string[]; eids: string[] }>
    const matchingKeys = Object.entries(ancestral).filter(([k]) => k.includes('@body_ex1/face0'))
    expect(matchingKeys.length).toBe(1)
    expect(matchingKeys[0][1].eids.length).toBe(1)
  })

  it('rollback mid-stack only solves active features', () => {
    /** rollbackPosition=2 on a 4-feature stack only solves the first two. */
    const spec = { features: [
      rectSketch('sk1', 5, 3),
      extrudeSpec('sk1', 'ex1', { distance: 5 }),
      rectSketch('sk2', 2, 2),
      extrudeSpec('sk2', 'ex2', { distance: 3 }),
    ]}
    const r = h.run(spec, { rollbackPosition: 2 })
    const result = r.result as Record<string, Record<string, unknown>>
    expect(result.sk1).toBeDefined()
    expect(result.ex1).toBeDefined()
    expect(result.sk2).toBeUndefined()
    expect(result.ex2).toBeUndefined()
    expect(r._build_state!.feature_order).toEqual(['sk1', 'ex1', 'sk2', 'ex2'])
  })

  it('feature reorder triggers rebuild of all changed features', () => {
    /** [sk1, ex1, sk2] → [sk1, sk2, ex1]: all after index 0 rebuilt. */
    const sk1 = rectSketch('sk1', 10, 10)
    const ex1 = extrudeSpec('sk1', 'ex1', { distance: 5 })
    const sk2 = rectSketch('sk2', 3, 3, { plane: '@builtin_plane_right' })
    const spec = { features: [sk1, ex1, sk2] }
    const r1 = h.run(spec)
    expect(h.res(r1, 'sk1').status).not.toBe('exception')

    // Reorder: [sk1, sk2, ex1]
    const r2 = h.run({ features: [sk1, sk2, ex1] }, { prevState: r1._build_state })
    expect(h.res(r2, 'ex1').status).toBe('ok')
    expect(r2._build_state!.feature_order).toEqual(['sk1', 'sk2', 'ex1'])
  })

  it('feature deletion triggers rebuild of later features', () => {
    /** [sk1, ex1, sk2] → [sk1, ex1]: sk2 removed, ex1 checkpoint reused. */
    const sk1 = rectSketch('sk1', 10, 10)
    const ex1 = extrudeSpec('sk1', 'ex1', { distance: 5 })
    const sk2 = rectSketch('sk2', 3, 3, { plane: '@builtin_plane_right' })
    const spec = { features: [sk1, ex1, sk2] }
    const r1 = h.run(spec)

    // Delete sk2: [sk1, ex1]
    const r2 = h.run({ features: [sk1, ex1] }, { prevState: r1._build_state })
    expect(h.res(r2, 'ex1').status).toBe('ok')
    expect(r2._build_state!.feature_order).toEqual(['sk1', 'ex1'])
    expect(Object.keys(r2._build_state!.checkpoints)).toEqual(['sk1', 'ex1'])
  })

  it('feature insertion triggers rebuild of later features', () => {
    /** [sk1, ex1] → [sk1, sk2, ex1]: sk2 inserted, sk1 reused, ex1 rebuilt. */
    const sk1 = rectSketch('sk1', 10, 10)
    const ex1 = extrudeSpec('sk1', 'ex1', { distance: 5 })
    const spec = { features: [sk1, ex1] }
    const r1 = h.run(spec)

    // Insert sk2 between sk1 and ex1
    const sk2 = rectSketch('sk2', 3, 3, { plane: '@builtin_plane_right' })
    const r2 = h.run({ features: [sk1, sk2, ex1] }, { prevState: r1._build_state })
    expect(h.res(r2, 'ex1').status).toBe('ok')
    expect(r2._build_state!.feature_order).toEqual(['sk1', 'sk2', 'ex1'])
  })

  it('fillet before its extrude must fail', () => {
    /** A fillet placed before its body's extrude must hard-fail. */
    const sk = rectSketch('skB', 10, 10, { plane: '@builtin_plane_top' })
    const r0 = h.run({ features: [sk, extrudeSpec('skB', 'exB', { distance: 5, operation: 'new' })] })
    const q = (h.body(r0, 'body_exB').edge_queries as string[])[0]
    const r = h.run({ features: [sk, { id: 'filB', kind: 'fillet', edges: [q], radius: 1 }, extrudeSpec('skB', 'exB', { distance: 5, operation: 'new' })] })
    expect(h.res(r, 'filB').status).toBe('exception')
  })

  it('delete sketch cascades to extrude and fillet', () => {
    /**
     * Deleting a sketch must fail its own extrude+fillet while independent features continue to
     * work.
     */
    const skA = rectSketch('skA', 10, 10, { plane: '@builtin_plane_top' })
    const skB = { ...rectSketch('skB', 10, 10, { plane: '@builtin_plane_top' }),
      initial: { bottom: [30, 0, 40, 0], right: [40, 0, 40, 10], top: [40, 10, 30, 10], left: [30, 10, 30, 0] },
      constraints: rectSketch('skB', 10, 10, { plane: '@builtin_plane_top' }).constraints }

    const r0 = h.run({ features: [skA, skB, extrudeSpec('skA', 'exA', { distance: 5, operation: 'new' }), extrudeSpec('skB', 'exB', { distance: 5, operation: 'new' })] })
    const qA = (h.body(r0, 'body_exA').edge_queries as string[])[0]
    const qB = (h.body(r0, 'body_exB').edge_queries as string[])[0]

    // Delete skB: exB can't resolve $skB -> exception, filB can't resolve
    const rDelB = h.run({ features: [skA, extrudeSpec('skA', 'exA', { distance: 5, operation: 'new' }), extrudeSpec('skB', 'exB', { distance: 5, operation: 'new' }), { id: 'filA', kind: 'fillet', edges: [qA], radius: 1 }, { id: 'filB', kind: 'fillet', edges: [qB], radius: 1 }] })
    expect(h.res(rDelB, 'exA').status).toBe('ok')
    expect(h.res(rDelB, 'exB').status).toBe('exception')
    expect(h.res(rDelB, 'filA').status).toBe('ok')
  })

  // `handleMutation` (hooks/usePartDoc.ts) used to pass `bypassCache: true` for
  // every doc edit, so no ordinary edit ever exercised the incremental path.
  // Now only a drag does, which makes these the sequences the app actually runs.
  // `_validate` builds the doc a SECOND time from scratch and diffs spec
  // hashes, result dicts and repo snapshots (validateIncremental, builder.ts):
  // level 3 + passed is the statement that incremental == full rebuild here.
  describe('an app-shaped edit sequence stays identical to a full rebuild', () => {
    const sk1 = rectSketch('sk1', 10, 10)
    const ex1 = extrudeSpec('sk1', 'ex1', { distance: 5, operation: 'new' })
    const sk2 = rectSketch('sk2', 3, 3, { plane: '@builtin_plane_right' })
    const ex2 = extrudeSpec('sk2', 'ex2', { distance: 4, operation: 'new' })

    it('deleting a mid-stack feature', () => {
      const r1 = h.run({ features: [sk1, ex1, sk2, ex2] })
      expect(h.res(r1, 'ex2').status).toBe('ok')

      // The delete_feature mutation: sk2 and its extrude leave the stack.
      const r2 = h.run({ features: [sk1, ex1], _validate: true }, { prevState: r1._build_state })
      expect(r2._validation).toMatchObject({ level: 3, passed: true })
    })

    it('editing a parameter behind another feature', () => {
      const r1 = h.run({ features: [sk1, ex1, sk2, ex2] })
      // Edit the FIRST extrude: everything behind it is dirty, sk1 is not.
      const edited = extrudeSpec('sk1', 'ex1', { distance: 9, operation: 'new' })
      const r2 = h.run({ features: [sk1, edited, sk2, ex2], _validate: true }, { prevState: r1._build_state })
      expect(r2._validation).toMatchObject({ level: 3, passed: true })
    })

    it('appending a feature after an import', () => {
      const imp = { id: 'imp1', kind: 'import_step', file_data: importFx.file_data, scale: 1 }
      const r1 = h.run({ features: [imp, sk1] })
      const r2 = h.run({ features: [imp, sk1, ex1], _validate: true }, { prevState: r1._build_state })
      expect(r2._validation).toMatchObject({ level: 3, passed: true })
    })

    it('deleting an imported body', () => {
      const imp = { id: 'imp1', kind: 'import_step', file_data: importFx.file_data, scale: 1 }
      const r1 = h.run({ features: [imp, sk1, ex1] })
      const importedId = Object.keys(r1.bodies).find((b) => b.startsWith('body_imp1'))
      expect(importedId).toBeDefined()

      const del = { id: 'del1', kind: 'delete_body', delete_body: { bodies: [importedId] } }
      const r2 = h.run({ features: [imp, sk1, ex1, del], _validate: true }, { prevState: r1._build_state })
      expect(h.res(r2, 'del1').status).toBe('ok')
      expect(Object.keys(r2.bodies)).not.toContain(importedId)
      expect(r2._validation).toMatchObject({ level: 3, passed: true })
    })
  })
})
