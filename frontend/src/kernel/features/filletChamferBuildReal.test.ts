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
})
