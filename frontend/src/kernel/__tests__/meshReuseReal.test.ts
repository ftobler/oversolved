// @vitest-environment node
//
// Render-mesh reuse through the production engine (solveLocally): a body the
// edited tail left alone keeps last solve's mesh object, that mesh equals a cold
// solve's tessellation, the parity oracle catches a corrupted cache, and the
// worker's transfer packing never detaches a cached mesh.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { solveLocally, setSolveLocalsForTest } from '../solveLocally'
import { setSketchSolver, resetSketchSolver } from '../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { handleSolveRequest, collectTransferables } from '../worker/solverWorker'
import { firstMeshDifference, MeshReuseMismatchError, finalCheckpointOf } from '../builderMeshReuse'
import type { BuildResponse } from '../builder'

const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketch(sketchId: string, w: number, h: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: { bottom: [0, 0, w, 0], right: [w, 0, w, h], top: [w, h, 0, h], left: [0, h, 0, 0] },
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

const extrude = (id: string, sketch: string, distance: number, operation = 'new') =>
  ({ id, kind: 'extrude', sketch: '$' + sketch, distance, direction: 'normal', operation })

// Two separate bodies: body_ex1 (20x20x10) and body_ex2 (8x8x30), never fused.
const twoParts = () => [rectSketch('sk1', 20, 20), extrude('ex1', 'sk1', 10), rectSketch('sk2', 8, 8), extrude('ex2', 'sk2', 30)]

async function solve(features: unknown[], options: Parameters<typeof solveLocally>[1] = {}): Promise<BuildResponse> {
  const r = await solveLocally({ features }, options)
  if (!r) throw new Error('OCC unavailable')
  return r
}

const partsOf = (r: BuildResponse) => r.bodies as Record<string, Record<string, unknown>>
const status = (r: BuildResponse, fid: string) => (r.result[fid] as Record<string, unknown>).status

describe.skipIf(!oc || !solveBytes)('mesh reuse through solveLocally (real OCC + Rust solver)', () => {
  let filletEdge = ''

  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
    setSolveLocalsForTest(async () => oc)
  })

  // The topology module is wired per test (test-setup.ts), so the edge the
  // fillet targets is harvested on the first test's solve, not in beforeAll.
  beforeEach(async () => {
    if (filletEdge) return
    const seed = await solve(twoParts(), { bypassCache: true })
    filletEdge = (partsOf(seed).body_ex2.edge_queries as string[])[0]
    expect(filletEdge).toBeTruthy()
  })

  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  const withFillet = (radius: number) => [...twoParts(), { id: 'fi1', kind: 'fillet', edges: [filletEdge], radius }]

  it('reuses the untouched body on a fillet edit, and both bodies match a cold solve', async () => {
    const r1 = await solve(withFillet(1), { bypassCache: true })
    expect(status(r1, 'fi1')).toBe('ok')
    const r2 = await solve(withFillet(2), { verifyMeshReuse: true })
    expect(status(r2, 'fi1')).toBe('ok')
    expect(partsOf(r2).body_ex1).toBe(partsOf(r1).body_ex1)
    expect(partsOf(r2).body_ex2).not.toBe(partsOf(r1).body_ex2)

    const cold = await solve(withFillet(2), { bypassCache: true })
    expect(firstMeshDifference(partsOf(r2).body_ex1, partsOf(cold).body_ex1)).toBeNull()
    expect(firstMeshDifference(partsOf(r2).body_ex2, partsOf(cold).body_ex2)).toBeNull()
  })

  it('re-meshes a body whose fillet is edited into an error, not last solve\'s filleted mesh', async () => {
    // The previous final mesh is filleted; the restored body is not and stays
    // so. Its history is clean, so only the provenance can refuse the reuse.
    await solve(withFillet(1), { bypassCache: true })
    const r2 = await solve(withFillet(500), { verifyMeshReuse: true })
    expect(status(r2, 'fi1')).not.toBe('ok')
    const cold = await solve(twoParts(), { bypassCache: true })
    expect(firstMeshDifference(partsOf(r2).body_ex2, partsOf(cold).body_ex2)).toBeNull()
  })

  it('reuses a merged body after a union consumed the other, across a later edit', async () => {
    const doc = (d: number) => [
      ...twoParts(),
      { id: 'bo1', kind: 'boolean', boolean: { operation: 'union', target: '@ex2', tools: ['@ex1'] } },
      rectSketch('sk3', 4, 4),
      extrude('ex3', 'sk3', d),
    ]
    const r1 = await solve(doc(40), { bypassCache: true })
    expect(status(r1, 'bo1')).toBe('ok')
    expect(Object.keys(partsOf(r1))).not.toContain('body_ex1')
    const r2 = await solve(doc(45), { verifyMeshReuse: true })
    expect(Object.keys(partsOf(r2)).sort()).toEqual(['body_ex2', 'body_ex3'])
    expect(partsOf(r2).body_ex2).toBe(partsOf(r1).body_ex2)
    expect(partsOf(r2).body_ex3).not.toBe(partsOf(r1).body_ex3)
  })

  it('the parity oracle throws on a corrupted cached mesh, naming the body', async () => {
    const r1 = await solve(withFillet(1), { bypassCache: true })
    const cached = partsOf(r1).body_ex1.mesh as { vertices: number[][] }
    const saved = cached.vertices[0][0]
    cached.vertices[0][0] = saved + 1
    try {
      await expect(solve(withFillet(2), { verifyMeshReuse: true })).rejects.toSatisfy(
        (e: unknown) => e instanceof MeshReuseMismatchError && e.partId === 'body_ex1')
    } finally {
      cached.vertices[0][0] = saved
    }
    // The mismatch dropped the engine cache, so the next solve is a clean cold
    // one rather than a restore from the generation the failed build released.
    const r3 = await solve(withFillet(3), { verifyMeshReuse: true })
    expect(status(r3, 'fi1')).toBe('ok')
    expect(partsOf(r3).body_ex1).not.toBe(partsOf(r1).body_ex1)
  })

  it('a cached pick world survives the worker transfer and is served again', async () => {
    // Editing fi1 (boundary 4): the pick world is the two unfilleted bodies.
    const r1 = await solve(withFillet(1), { bypassCache: true, pickBoundary: 4 })
    const r2 = await solve(withFillet(2), { pickBoundary: 4, verifyMeshReuse: true })
    expect(r2.pick_bodies).toBe(r1.pick_bodies)

    const res = await handleSolveRequest({ id: 1, spec: {}, options: {} }, async () => r2)
    const transfer = collectTransferables(res)
    expect(transfer.length).toBeGreaterThan(0)
    structuredClone(res, { transfer })

    const pick = r2.pick_bodies as Record<string, { mesh: { vertices: number[][] } }>
    for (const entry of Object.values(pick)) {
      expect(entry.mesh.vertices.length).toBeGreaterThan(0)
      expect(entry.mesh.vertices[0]).toHaveLength(3)
    }
    const final = finalCheckpointOf(r2._build_state)
    expect(final).not.toBeNull()
    const r3 = await solve(withFillet(3), { pickBoundary: 4, verifyMeshReuse: true })
    expect(r3.pick_bodies).toBe(r1.pick_bodies)
    expect(partsOf(r3).body_ex1).toBe(partsOf(r2).body_ex1)
  })
})
