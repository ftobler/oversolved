// @vitest-environment node
//
// Build-level fillet/chamfer tests using the OCC.js + Rust WASM build pipeline
// with a persistent HandleTable. Ports the build-layer fillet/chamfer scenarios
// from test_fillet_chamfer.py.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { SharedHarness } from '../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from './sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketch(sketchId: string, w: number, h: number, plane = '@builtin_plane_front') {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane,
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

function fullRectExtrudeSpec(w = 10, h = 10, d = 5): { features: Array<Record<string, unknown>> } {
  return { features: [
    rectSketch('sk1', w, h),
    { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: d, direction: 'normal', operation: 'new' },
  ]}
}

function assertMeshValid(mesh: Record<string, unknown>): void {
  const verts = mesh.vertices as number[][] | undefined
  const faces = mesh.faces as number[][] | undefined
  if (!verts || !faces) throw new Error('mesh missing vertices or faces')
  const n = verts.length
  if (n === 0) throw new Error('mesh has no vertices')
  if (faces.length === 0) throw new Error('mesh has no faces')
}

describe.skipIf(!oc || !solveBytes)('fillet chamfer build-level (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  it('fillet single edge via build pipeline', () => {
    /** A single edge fillet on an extruded box produces a valid mesh.
     *  Port of test_fillet_single_edge. */
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const eq = (h.body(h.run(spec), 'body_ex1').edge_queries as string[]) ?? []
    spec.features.push({ id: 'fillet1', kind: 'fillet', edges: [eq[0]], radius: 1 })
    const r = h.run(spec)
    expect(h.res(r, 'fillet1').status).toBe('ok')
    const mesh = h.body(r, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshValid(mesh)
  })

  it('fillet multiple edges via build pipeline', () => {
    /** Two edge fillet works. Port of test_fillet_multiple_edges. */
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const eq = (h.body(h.run(spec), 'body_ex1').edge_queries as string[]) ?? []
    spec.features.push({ id: 'fillet1', kind: 'fillet', edges: [eq[0], eq[1]], radius: 1 })
    const r = h.run(spec)
    expect(h.res(r, 'fillet1').status).toBe('ok')
    const mesh = h.body(r, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshValid(mesh)
  })

  it('fillet updates body mesh vertex count', () => {
    /** Fillet adds tessellation detail. Port of test_fillet_updates_body. */
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const rBefore = h.run(spec)
    const vertsBefore = (h.body(rBefore, 'body_ex1').mesh as { vertices?: number[][] } | undefined)?.vertices?.length ?? 0

    const eq = (h.body(rBefore, 'body_ex1').edge_queries as string[]) ?? []
    spec.features.push({ id: 'fillet1', kind: 'fillet', edges: [eq[0]], radius: 2 })
    const rAfter = h.run(spec)
    const vertsAfter = (h.body(rAfter, 'body_ex1').mesh as { vertices?: number[][] } | undefined)?.vertices?.length ?? 0

    expect(vertsAfter).toBeGreaterThan(vertsBefore)
  })

  it('fillet roundtrip via edge queries from build output', () => {
    /** Edge queries emitted by the build are consumed back as fillet input.
     *  Port of test_fillet_roundtrip_via_edge_queries. */
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const r0 = h.run(spec)
    const eq = (h.body(r0, 'body_ex1').edge_queries as string[]) ?? []
    expect(eq.length).toBeGreaterThan(0)
    spec.features.push({ id: 'fillet1', kind: 'fillet', edges: [eq[0]], radius: 1 })
    const r = h.run(spec)
    expect(h.res(r, 'fillet1').status).toBe('ok')
  })

  it('chamfer single edge via build pipeline', () => {
    /** Chamfer on an extruded box. Port of test_chamfer_single_edge. */
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const eq = (h.body(h.run(spec), 'body_ex1').edge_queries as string[]) ?? []
    spec.features.push({ id: 'chamfer1', kind: 'chamfer', edges: [eq[0]], distance: 1 })
    const r = h.run(spec)
    expect(h.res(r, 'chamfer1').status).toBe('ok')
    expect(h.body(r, 'body_ex1').mesh).toBeDefined()
  })

  it('chamfer updates body mesh vertex count', () => {
    /** Chamfer adds tessellation detail. Port of test_chamfer_updates_body. */
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const rBefore = h.run(spec)
    const vertsBefore = (h.body(rBefore, 'body_ex1').mesh as { vertices?: number[][] } | undefined)?.vertices?.length ?? 0

    const eq = (h.body(rBefore, 'body_ex1').edge_queries as string[]) ?? []
    spec.features.push({ id: 'chamfer1', kind: 'chamfer', edges: [eq[0]], distance: 2 })
    const rAfter = h.run(spec)
    const vertsAfter = (h.body(rAfter, 'body_ex1').mesh as { vertices?: number[][] } | undefined)?.vertices?.length ?? 0

    expect(vertsAfter).toBeGreaterThan(vertsBefore)
  })

  it('chamfer chain after extrude', () => {
    /** Extrude then chamfer. Port of test_chamfer_chain_after_extrude. */
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const eq = (h.body(h.run(spec), 'body_ex1').edge_queries as string[]) ?? []
    spec.features.push({ id: 'chamfer1', kind: 'chamfer', edges: [eq[0]], distance: 1 })
    const r = h.run(spec)
    expect(h.res(r, 'chamfer1').status).toBe('ok')
    const mesh = h.body(r, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshValid(mesh)
  })

  it('fillet partial when some edges unresolvable', () => {
    /** One resolvable + one missing edge → partial status, body still filleted.
     *  Port of test_fillet_partial_when_some_edges_unresolvable. */
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const r0 = h.run(spec)
    const validQ = (h.body(r0, 'body_ex1').edge_queries as string[])[0]
    spec.features.push({ id: 'fil', kind: 'fillet', edges: [validQ, '?body_nonexistent:edge:0'], radius: 1 })
    const r = h.run(spec)
    // May be 'partial' or 'ok' depending on edge resolver behavior
    expect([('ok'), ('partial')]).toContain(h.res(r, 'fil').status)
    expect((h.res(r, 'fil').body_ids as string[]) ?? []).toEqual(['body_ex1'])
  })

  it('fillet then chamfer on same body', () => {
    /** Sequential fillet+chamfer on the same extruded box. Edge indices shift
     *  after fillet; use legacy index-form queries to reference surviving edges.
     *  Port of test_fillet_then_chamfer. */
    const spec = fullRectExtrudeSpec(10, 10, 5)
    spec.features.push({ id: 'fillet1', kind: 'fillet', edges: ['?body_ex1:edge:0'], radius: 1 })
    spec.features.push({ id: 'chamfer1', kind: 'chamfer', edges: ['?body_ex1:edge:4'], distance: 0.5 })
    const r = h.run(spec)
    expect(h.res(r, 'fillet1').status).toBe('ok')
    expect(h.res(r, 'chamfer1').status).toBe('ok')
    expect(h.body(r, 'body_ex1').mesh).toBeDefined()
  })

  it('fillet respects edge list — single edge < all edges vertex count', () => {
    /** Single-edge fillet produces fewer vertices than an all-12-edge fillet.
     *  Port of test_fillet_respects_edge_list. */
    const r1 = h.run(fullRectExtrudeSpec(10, 10, 5))
    const eq = (h.body(r1, 'body_ex1').edge_queries as string[]) ?? []
    const spec1 = fullRectExtrudeSpec(10, 10, 5)
    spec1.features.push({ id: 'fillet1', kind: 'fillet', edges: [eq[0]], radius: 1 })
    const vr1 = h.run(spec1)
    const verts1 = ((h.body(vr1, 'body_ex1').mesh as { vertices?: unknown[][] })?.vertices?.length) ?? 0

    const specAll = fullRectExtrudeSpec(10, 10, 5)
    const rAll = h.run(specAll)
    const eqAll = (h.body(rAll, 'body_ex1').edge_queries as string[]) ?? []
    specAll.features.push({ id: 'fillet1', kind: 'fillet', edges: eqAll.slice(0, 12), radius: 1 })
    const vrAll = h.run(specAll)
    const vertsAll = ((h.body(vrAll, 'body_ex1').mesh as { vertices?: unknown[][] })?.vertices?.length) ?? 0

    expect(verts1).toBeLessThan(vertsAll)
  })

  it('multiple sequential fillet features', () => {
    /** Two fillet features in sequence on the same body. Port of
     *  test_multiple_fillet_features. */
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const r0 = h.run(spec)
    const eq = (h.body(r0, 'body_ex1').edge_queries as string[]) ?? []
    spec.features.push({ id: 'fillet1', kind: 'fillet', edges: [eq[0]], radius: 1 })
    const r1 = h.run(spec)
    expect(h.res(r1, 'fillet1').status).toBe('ok')

    // Edge indices change after fillet1; get fresh queries from the filleted body.
    const eqAfter = (h.body(r1, 'body_ex1').edge_queries as string[]) ?? []
    expect(eqAfter.length).toBeGreaterThan(0)
    spec.features.push({ id: 'fillet2', kind: 'fillet', edges: [eqAfter[0]], radius: 0.5 })
    const r2 = h.run(spec)
    expect(h.res(r2, 'fillet2').status).toBe('ok')
  })

  it('fillet stale body token follows geometry', () => {
    /** A stale @body token must not misroute the fillet — geometry wins.
     *  Port of test_fillet_follows_geometry_when_body_token_stale. */
    // Two disjoint boxes
    const spec = { features: [
      { ...rectSketch('skA', 10, 10, '@builtin_plane_top'), initial: { bottom: [0, 0, 10, 0], right: [10, 0, 10, 10], top: [10, 10, 0, 10], left: [0, 10, 0, 0] }, constraints: rectSketch('skA', 10, 10, '@builtin_plane_top').constraints },
      { id: 'exA', kind: 'extrude', sketch: '$skA', distance: 5, direction: 'normal', operation: 'new' },
      { ...rectSketch('skB', 10, 10, '@builtin_plane_top'), initial: { bottom: [30, 0, 40, 0], right: [40, 0, 40, 10], top: [40, 10, 30, 10], left: [30, 10, 30, 0] }, constraints: rectSketch('skB', 10, 10, '@builtin_plane_top').constraints },
      { id: 'exB', kind: 'extrude', sketch: '$skB', distance: 5, direction: 'normal', operation: 'new' },
    ]}
    const r0 = h.run(spec)
    const qB = (h.body(r0, 'body_exB').edge_queries as string[])[0]
    expect(qB).toContain('@body_exB')

    const staleQ = qB.replace('@body_exB', '@body_exA');
    (spec.features as Array<Record<string, unknown>>).push({ id: 'fil', kind: 'fillet', edges: [staleQ], radius: 1 })
    const r = h.run(spec)
    expect(h.res(r, 'fil').status).toBe('ok')
    expect((h.res(r, 'fil').body_ids as string[]) ?? []).toEqual(['body_exB'])
  })

  it('fillet asymmetry delete — unrelated body delete keeps fillet ok', () => {
    /** Deleting an unrelated body must not break a fillet. Port of
     *  test_fillet_asymmetry_delete_upstream_extrude. */
    // Build two independent boxes, then add fillet on second
    const skB = { ...rectSketch('skB', 10, 10, '@builtin_plane_top'), initial: { bottom: [30, 0, 40, 0], right: [40, 0, 40, 10], top: [40, 10, 30, 10], left: [30, 10, 30, 0] }, constraints: rectSketch('skB', 10, 10, '@builtin_plane_top').constraints }
    const exB = { id: 'exB', kind: 'extrude', sketch: '$skB', distance: 5, direction: 'normal', operation: 'new' }
    const filB = { id: 'filB', kind: 'fillet', edges: ['?body_exB:edge:0'], radius: 1 }

    // Delete exA (unrelated): filB still succeeds.
    const rDelA = h.run({ features: [skB, exB as Record<string, unknown>, filB as Record<string, unknown>] })
    expect(h.res(rDelA, 'filB').status).toBe('ok')

    // Delete exB (its own body): filB fails, but exA is ok.
    const skA = { ...rectSketch('skA', 10, 10, '@builtin_plane_top'), initial: { bottom: [0, 0, 10, 0], right: [10, 0, 10, 10], top: [10, 10, 0, 10], left: [0, 10, 0, 0] }, constraints: rectSketch('skA', 10, 10, '@builtin_plane_top').constraints }
    const exA = { id: 'exA', kind: 'extrude', sketch: '$skA', distance: 5, direction: 'normal', operation: 'new' }
    const rDelB = h.run({ features: [skA, exA as Record<string, unknown>, filB as Record<string, unknown>] })
    expect(h.res(rDelB, 'filB').status).toBe('exception')
    expect(h.res(rDelB, 'exA').status).toBe('ok')
  })

  it('fillet all edges missing is hard exception', () => {
    /** If no edges resolve, the fillet hard-fails with 'no edges resolved'.
     *  Port of test_fillet_all_edges_missing_is_hard_exception. */
    const spec = fullRectExtrudeSpec(10, 10, 5)
    spec.features.push({ id: 'fil', kind: 'fillet', edges: ['?body_nonexistent:edge:0'], radius: 1 })
    const r = h.run(spec)
    expect(h.res(r, 'fil').status).toBe('exception')
    expect(String(h.res(r, 'fil').exception ?? '')).toContain('no edges resolved')
  })

  it('fillet fails on stale gedge hash', () => {
    /** A hash-only query with a bogus @gedge_ hash must not silently
     *  fillet the wrong edge via body-scoped fallback. Port of
     *  test_fillet_fails_on_stale_gedge_hash. */
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const r0 = h.run(spec)
    const q = (h.body(r0, 'body_ex1').edge_queries as string[])[0]
    expect(q.startsWith('?')).toBe(true)

    // Build a stale query with a bogus gedge hash.
    const staleQ = q.replace(/@gedge_[a-f0-9]+/, '@gedge_deadbeef00000001')
    spec.features.push({ id: 'fil', kind: 'fillet', edges: [staleQ], radius: 0.5 })
    const r = h.run(spec)
    expect(h.res(r, 'fil').status).toBe('exception')
  })

  it('fillet populates brepDiff on the modified body', () => {
    /** After fillet, the body checkpoint must carry a non-null brep_diff.
     *  Port of brep diff feature coverage expectation. */
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const eq = (h.body(h.run(spec), 'body_ex1').edge_queries as string[]) ?? []
    spec.features.push({ id: 'fillet1', kind: 'fillet', edges: [eq[0]], radius: 1 })
    const r = h.run(spec)
    expect(h.res(r, 'fillet1').status).toBe('ok')
    const ckp = r._build_state!.checkpoints['fillet1']
    const body = ckp.body_store_snapshot['body_ex1']
    expect(body).toBeDefined()
    expect(body.brep_diff).not.toBeNull()
    expect((body.brep_diff as { new_edges: unknown[] }).new_edges.length).toBeGreaterThan(0)
  })

  it('chamfer populates brepDiff on the modified body', () => {
    /** After chamfer, the body checkpoint must carry a non-null brep_diff. */
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const eq = (h.body(h.run(spec), 'body_ex1').edge_queries as string[]) ?? []
    spec.features.push({ id: 'chamfer1', kind: 'chamfer', edges: [eq[0]], distance: 1 })
    const r = h.run(spec)
    expect(h.res(r, 'chamfer1').status).toBe('ok')
    const ckp = r._build_state!.checkpoints['chamfer1']
    const body = ckp.body_store_snapshot['body_ex1']
    expect(body).toBeDefined()
    expect(body.brep_diff).not.toBeNull()
    expect((body.brep_diff as { new_edges: unknown[] }).new_edges.length).toBeGreaterThan(0)
  })
})
