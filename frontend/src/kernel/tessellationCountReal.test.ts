// @vitest-environment node
//
// Benchmark / regression guard for the rebuild tessellation cost (feature
// `rebuild-tessellation-cost`). Counts how many times the RENDER triangulation
// (`solidToMesh`, via `tessellateBodies`) runs during a build. The mesh-free
// metadata path (`extractBrepMetadata`) is intentionally NOT counted -- it does
// no triangulation.
//
// Under lazy checkpoint meshing a full build must render exactly the final body
// set once (plus at most one lazy boundary tessellation for an active
// `pick_boundary`), NOT one triangulation per feature checkpoint. A regression
// back to per-checkpoint meshing would push this count up to O(features).
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './occ/loadOcc'
import { DisposeScope } from './occ/disposeScope'
import { HandleTable } from './occ/handleTable'
import { build, type BuildDeps, type BuildResponse } from './builder'
import type { BuildState } from './types3d'
import { initGlobalRepo } from './query'
import { createFeatureSolver } from './solverRegistry'
import { postRegister } from './features/postRegister'
import { solidToMesh, solidToEdges, solidToVertices } from './occ/tessellation'
import { extractBrepMetadata } from './solveLocally'
import { brepDiffNewFaceHashes, brepDiffNewEdgeHashes, brepDiffNewVertexHashes } from './occ/brepDiffHash'
import { copyShape } from './occ/transforms'
import type { OccShape } from './occ/occTypes'
import { setSketchSolver, resetSketchSolver } from './features/sketch'
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

function extrudeSpec(sketchId: string, extrudeId: string, distance: number) {
  return {
    id: extrudeId, kind: 'extrude', sketch: '$' + sketchId,
    distance, direction: 'normal', operation: 'add',
  }
}

// Counting harness: identical wiring to SharedHarness, but every body meshed by
// the RENDER path (`tessellateBodies` -> `solidToMesh`) bumps `renderCount`.
class CountingHarness {
  readonly table = new HandleTable({ finalizerGuard: false })
  renderCount = 0

  run(
    spec: Record<string, unknown>,
    opts?: { prevState?: BuildState | null; pickBoundary?: number | null },
  ): BuildResponse {
    const scope = new DisposeScope()
    try {
      const deps: BuildDeps = {
        trySolveFeature: createFeatureSolver(oc!, scope, this.table),
        postRegister, initGlobalRepo,
        tessellateBodies: (bodyStore) => {
          const out: Record<string, Record<string, unknown>> = {}
          for (const body of Object.values(bodyStore)) {
            if (!body.shape) continue
            try {
              this.renderCount += 1  // one render triangulation for this body
              const mesh = solidToMesh(oc!, this.table, body.shape, {
                createdBy: body.created_by || '', bodyId: body.id,
                faceAncestry: body.face_ancestry ?? null, faceNames: body.face_names ?? null,
                profileQueries: body.profile_queries ?? [],
              })
              const edgeResult = solidToEdges(oc!, this.table, body.shape, {
                createdBy: body.created_by || '', bodyId: body.id,
                profileQueries: body.profile_queries ?? [],
                edgeAncestry: body.edge_ancestry ?? null, edgeNames: body.edge_names ?? null,
              })
              const vertexResult = solidToVertices(oc!, this.table, body.shape, {
                createdBy: body.created_by || '', bodyId: body.id, profileQueries: body.profile_queries ?? [],
              })
              out[body.id] = {
                mesh, edges: edgeResult.edges, edge_queries: edgeResult.edge_queries,
                vertices: vertexResult.vertices, vertex_queries: vertexResult.vertex_queries,
              }
            } catch { /* non-fatal */ }
          }
          return out
        },
        extractBrepMetadata: (bodyStore) => extractBrepMetadata(oc!, this.table, bodyStore),
        brepDiffNewFaceHashes: (b) => brepDiffNewFaceHashes(oc!, scope, b),
        brepDiffNewEdgeHashes: (b) => brepDiffNewEdgeHashes(oc!, scope, b),
        brepDiffNewVertexHashes: (b) => brepDiffNewVertexHashes(oc!, scope, b),
        retainCheckpointShape: (h, owner) => this.table.retain(h, owner),
        copyBodyShape: (h) => this.table.register(copyShape(oc!, scope, this.table.get<OccShape>(h))),
        releaseCheckpoint: (fid) => this.table.releaseOwner('cp:' + fid),
      }
      return build(spec, {
        prevState: opts?.prevState ?? null,
        pickBoundary: opts?.pickBoundary ?? null,
        rollbackPosition: null,
      }, deps)
    } finally {
      scope.dispose()
    }
  }

  body(r: BuildResponse, bid: string): Record<string, unknown> {
    return (r.bodies as Record<string, Record<string, unknown>>)[bid] ?? {}
  }
}

describe.skipIf(!oc || !solveBytes)('rebuild tessellation count (real OCC + Rust solver)', () => {
  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver(); setSketchSolver(solveBytes)
  })

  // A single-body doc with several body-modifying features. Each fillet produces
  // a distinct body state, so the old per-checkpoint meshing would render the
  // body once per checkpoint (O(features)).
  function chainDoc(edgeQueries: string[]) {
    return { features: [
      rectSketch('sk1', 20, 20),
      extrudeSpec('sk1', 'ex1', 10),
      { id: 'fi1', kind: 'fillet', edges: [edgeQueries[0]], radius: 0.5 },
      { id: 'fi2', kind: 'fillet', edges: [edgeQueries[1]], radius: 0.5 },
      { id: 'fi3', kind: 'fillet', edges: [edgeQueries[2]], radius: 0.5 },
    ] }
  }

  it('renders the final body once, not once per checkpoint', () => {
    const h = new CountingHarness()
    // First build the box alone to harvest distinct edge queries for the fillets.
    const seed = h.run({ features: [rectSketch('sk1', 20, 20), extrudeSpec('sk1', 'ex1', 10)] })
    const eq = (h.body(seed, 'body_ex1').edge_queries as string[]) ?? []
    expect(eq.length).toBeGreaterThanOrEqual(3)

    const h2 = new CountingHarness()
    const r = h2.run(chainDoc(eq))
    // Every feature solved.
    for (const fid of ['ex1', 'fi1', 'fi2', 'fi3']) {
      expect((r.result as Record<string, Record<string, unknown>>)[fid].status).toBe('ok')
    }
    const finalBodies = Object.keys(r.bodies).length
    expect(finalBodies).toBe(1)
    // The proof of reduction: exactly one render triangulation per final body,
    // NOT one per feature checkpoint (which would be >= 4 here).
    expect(h2.renderCount).toBe(finalBodies)
  })

  it('adds exactly one lazy tessellation for a mid-stack pick_boundary', () => {
    const h = new CountingHarness()
    const seed = h.run({ features: [rectSketch('sk1', 20, 20), extrudeSpec('sk1', 'ex1', 10)] })
    const eq = (h.body(seed, 'body_ex1').edge_queries as string[]) ?? []

    const h2 = new CountingHarness()
    const r = h2.run(chainDoc(eq), { pickBoundary: 2 })  // boundary after ex1
    expect(r.pick_bodies).toBeDefined()
    expect(Object.keys(r.pick_bodies as object).length).toBeGreaterThan(0)
    // Final render (1) + one lazy boundary tessellation for the pick.
    expect(h2.renderCount).toBe(2)
  })

  it('renders zero times on a fully-clean rebuild (final mesh reused)', () => {
    const h = new CountingHarness()
    const seed = h.run({ features: [rectSketch('sk1', 20, 20), extrudeSpec('sk1', 'ex1', 10)] })
    const eq = (h.body(seed, 'body_ex1').edge_queries as string[]) ?? []

    const h2 = new CountingHarness()
    const doc = chainDoc(eq)
    const r1 = h2.run(doc)
    const countAfterFirst = h2.renderCount
    expect(countAfterFirst).toBeGreaterThan(0)

    // Re-solve the identical doc with the prior state: nothing is dirty, so the
    // final render mesh is reused and no triangulation runs.
    const r2 = h2.run(doc, { prevState: r1._build_state })
    expect(Object.keys(r2.bodies).length).toBe(1)
    expect(h2.renderCount - countAfterFirst).toBe(0)
  })
})
