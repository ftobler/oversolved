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
import { build, RESTORE_OWNER, type BuildDeps, type BuildResponse } from './builder'
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
import importFixture from './occ/__fixtures__/importStep.json'
import { base64ToBytes } from './occ/stepIo'

const oc = await loadOcc()
const solveBytes = loadSolver()
const importFx = importFixture as unknown as { file_data: string }
const importFiles = new Map<string, Uint8Array>([['imp1', base64ToBytes(importFx.file_data)]])

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
// the RENDER path (`tessellateBodies` -> `solidToMesh`) bumps `renderCount`, and
// every body read by the mesh-free metadata path is recorded in `metaExtracted`.
class CountingHarness {
  readonly table = new HandleTable()
  renderCount = 0
  rendered: string[] = []  // body ids passed through the render tessellation this run
  metaExtracted: string[] = []  // body ids passed through extractBrepMetadata this run

  run(
    spec: Record<string, unknown>,
    opts?: { prevState?: BuildState | null; pickBoundary?: number | null },
  ): BuildResponse {
    const scope = new DisposeScope()
    try {
      const deps: BuildDeps = {
        trySolveFeature: createFeatureSolver(oc!, scope, this.table, importFiles),
        postRegister, initGlobalRepo,
        tessellateBodies: (bodyStore) => {
          const out: Record<string, Record<string, unknown>> = {}
          for (const body of Object.values(bodyStore)) {
            if (!body.shape) continue
            try {
              this.renderCount += 1  // one render triangulation for this body
              this.rendered.push(body.id)
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
            } catch {  /* non-fatal */ }
          }
          return out
        },
        extractBrepMetadata: (bodyStore) => {
          for (const b of Object.values(bodyStore)) if (b.shape) this.metaExtracted.push(b.id)
          return extractBrepMetadata(oc!, this.table, bodyStore)
        },
        brepDiffNewFaceHashes: (b) => brepDiffNewFaceHashes(oc!, scope, b),
        brepDiffNewEdgeHashes: (b) => brepDiffNewEdgeHashes(oc!, scope, b),
        brepDiffNewVertexHashes: (b) => brepDiffNewVertexHashes(oc!, scope, b),
        retainCheckpointShape: (h, owner) => this.table.retain(h, owner),
        copyBodyShape: (h, owner) =>
          this.table.register(copyShape(oc!, scope, this.table.get<OccShape>(h)), owner),
        releaseCheckpoint: (fid) => {
          this.table.releaseOwner('cp:' + fid)
          this.table.releaseOwner(fid)
        },
        releaseRestoreCopies: () => this.table.releaseOwner(RESTORE_OWNER),
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

  // Imported-body tessellation cache (feature `cache-imported-tessellation`).
  // An imported STEP body carries heavy geometry whose tessellation is pure
  // recomputation on every unrelated downstream edit. When the import feature
  // sits in the clean prefix, its render mesh is reused from the previous solve
  // rather than re-triangulated. The shape HANDLE cannot key this: the
  // clean-prefix restore deep-copies each shape and mints a fresh handle every
  // solve, so identity has to come from the clean-prefix determination itself.
  // Import a STEP box (body_imp1) plus an independent native box (body_ex1) via
  // `operation: 'new'`, so the two bodies never fuse and the import stays clean
  // when only the native box is edited. The harness seeds imp1's bytes for every
  // run, so the reference resolves on the first solve and the checkpoint cache.
  function importPlusNativeDoc(distance: number) {
    return { features: [
      { id: 'imp1', kind: 'import_step', file_id: 'imp1', scale: 1 },
      rectSketch('sk1', 20, 20),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance, direction: 'normal', operation: 'new' },
    ] }
  }

  it('reuses a clean imported body mesh when an unrelated body is edited', () => {
    const h = new CountingHarness()
    const r1 = h.run(importPlusNativeDoc(10))
    expect(new Set(Object.keys(r1.bodies))).toEqual(new Set(['body_imp1', 'body_ex1']))
    // First solve tessellates both bodies.
    expect(new Set(h.rendered)).toEqual(new Set(['body_imp1', 'body_ex1']))

    // Edit only the native extrude distance: imp1 is a clean-prefix import, ex1
    // is dirty. The imported body's mesh is reused; only body_ex1 re-tessellates.
    h.rendered = []
    h.renderCount = 0
    const r2 = h.run(importPlusNativeDoc(15), { prevState: r1._build_state })
    expect(new Set(Object.keys(r2.bodies))).toEqual(new Set(['body_imp1', 'body_ex1']))
    expect(h.rendered).toEqual(['body_ex1'])
    expect(h.renderCount).toBe(1)
  })

  it('reused imported mesh is byte-identical to a fresh tessellation', () => {
    const h = new CountingHarness()
    const r1 = h.run(importPlusNativeDoc(10))
    const fresh = h.body(r1, 'body_imp1').mesh

    const r2 = h.run(importPlusNativeDoc(15), { prevState: r1._build_state })
    const reused = h.body(r2, 'body_imp1').mesh
    expect(reused).toEqual(fresh)
  })

  it('re-tessellates the imported body when the import feature itself is dirty', () => {
    const h = new CountingHarness()
    const r1 = h.run(importPlusNativeDoc(10))

    // Change the import scale: imp1 is now dirty (firstDirty == 0), so no reuse.
    h.rendered = []
    const doc2 = importPlusNativeDoc(10)
    ;(doc2.features[0] as Record<string, unknown>).scale = 2
    const r2 = h.run(doc2, { prevState: r1._build_state })
    expect(Object.keys(r2.bodies).length).toBe(2)
    expect(h.rendered).toContain('body_imp1')
  })

  // Mesh-free metadata is extracted per DIRTY CHECKPOINT, and every checkpoint
  // snapshots the whole body store -- so an untouched body used to be re-read
  // once per feature behind it, making each edit cost more the longer the stack
  // grew. Metadata depends only on the body's shape, so one read per distinct
  // body version is enough.
  function importPlusTwoNativeDoc() {
    return { features: [
      { id: 'imp1', kind: 'import_step', file_id: 'imp1', scale: 1 },
      rectSketch('sk1', 20, 20),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' },
      rectSketch('sk2', 8, 8, '@builtin_plane_top'),
      { id: 'ex2', kind: 'extrude', sketch: '$sk2', distance: 4, direction: 'normal', operation: 'new' },
    ] }
  }

  it('reads an untouched body metadata once, not once per checkpoint', () => {
    const h = new CountingHarness()
    const r = h.run(importPlusTwoNativeDoc())
    for (const fid of ['imp1', 'ex1', 'ex2']) {
      expect((r.result as Record<string, Record<string, unknown>>)[fid].status).toBe('ok')
    }
    // Each body is created once and never modified, so it has exactly one
    // version and is read exactly once -- even though body_imp1 is live in four
    // non-final checkpoints (imp1, sk1, ex1, sk2) plus the solve loop, and
    // body_ex1 in two plus the solve loop. The final checkpoint reads the render
    // mesh instead, so it never adds here.
    const times = (bid: string): number => h.metaExtracted.filter((b) => b === bid).length
    expect(times('body_imp1')).toBe(1)
    expect(times('body_ex1')).toBe(1)
  })

  it('re-reads metadata for a body that actually changes between checkpoints', () => {
    const h = new CountingHarness()
    const seed = h.run({ features: [rectSketch('sk1', 20, 20), extrudeSpec('sk1', 'ex1', 10)] })
    const eq = (h.body(seed, 'body_ex1').edge_queries as string[]) ?? []
    expect(eq.length).toBeGreaterThanOrEqual(3)

    const h2 = new CountingHarness()
    // Each fillet mutates body_ex1, so the cache must NOT collapse them. Four
    // versions exist (after ex1, fi1, fi2, fi3) and each is read exactly once:
    // the solve loop registers every new version, and the non-final checkpoints
    // (ex1, fi1, fi2) then hit the cache the loop already filled.
    h2.run(chainDoc(eq))
    expect(h2.metaExtracted.filter((b) => b === 'body_ex1').length).toBe(4)
  })

  // The pick world (the body set BEFORE the edited feature) is served from the
  // pick checkpoint's own bodies_snapshot -- but only the LAST feature's
  // checkpoint ever stores a render mesh, so a pick boundary anywhere else used
  // to re-tessellate the whole document. With a heavy STEP import behind the
  // edit that was 25% of a full import, on EVERY solve while the editor is open
  // (a clean-prefix checkpoint is carried over verbatim, so its empty snapshot
  // never fills in). An imported body clean at both the pick boundary and the
  // final checkpoint is byte-identical in both worlds, so last solve's mesh is
  // exact for the pick world too.
  describe('pick_boundary mesh reuse', () => {
    it('does not re-tessellate a clean imported body for the pick world', () => {
      const h = new CountingHarness()
      const doc = importPlusTwoNativeDoc()
      const r1 = h.run(doc)
      expect(Object.keys(r1.bodies)).toContain('body_imp1')

      // Enter the editor on ex2: pick_boundary lands on sk2, whose checkpoint
      // has no stored mesh. Only the edited feature's own body may re-render.
      h.rendered = []
      h.renderCount = 0
      const r2 = h.run(doc, { prevState: r1._build_state, pickBoundary: 4 })
      expect(Object.keys(r2.pick_bodies as object)).toContain('body_imp1')
      expect(h.rendered).not.toContain('body_imp1')
    })

    it('the reused pick mesh is byte-identical to a fresh tessellation', () => {
      const h = new CountingHarness()
      const doc = importPlusTwoNativeDoc()
      const r1 = h.run(doc)
      const fresh = (h.body(r1, 'body_imp1').mesh)

      const r2 = h.run(doc, { prevState: r1._build_state, pickBoundary: 4 })
      const picked = (r2.pick_bodies as Record<string, Record<string, unknown>>)['body_imp1']
      expect(picked.mesh).toEqual(fresh)
    })

    it('re-tessellates for the pick world when the import itself is dirty', () => {
      const h = new CountingHarness()
      const r1 = h.run(importPlusTwoNativeDoc())

      // Nothing is clean, so there is no previous mesh that can be trusted.
      const doc2 = importPlusTwoNativeDoc()
      ;(doc2.features[0] as Record<string, unknown>).scale = 2
      h.rendered = []
      const r2 = h.run(doc2, { prevState: r1._build_state, pickBoundary: 4 })
      expect(Object.keys(r2.pick_bodies as object)).toContain('body_imp1')
      expect(h.rendered).toContain('body_imp1')
    })

    // The sharp case the reuse guard exists for. The mesh on offer comes from
    // the FINAL checkpoint, so an imported body that a later (still clean)
    // feature modified is a DIFFERENT shape in the pick world. Its own history
    // at the pick checkpoint does not yet name that feature, so the clean-prefix
    // test alone says "reuse" and would serve the post-modification geometry as
    // the "before" state.
    it('re-tessellates an imported body a later clean feature modified', () => {
      const imp = { id: 'imp1', kind: 'import_step', file_id: 'imp1', scale: 1 }
      const seedH = new CountingHarness()
      const seed = seedH.run({ features: [imp] })
      const eq = (seedH.body(seed, 'body_imp1').edge_queries as string[]) ?? []
      expect(eq.length).toBeGreaterThan(0)

      const h = new CountingHarness()
      const doc = {
        features: [
          imp,
          { id: 'fi1', kind: 'fillet', edges: [eq[0]], radius: 0.5 },
          rectSketch('sk2', 8, 8, '@builtin_plane_top'),
          { id: 'ex2', kind: 'extrude', sketch: '$sk2', distance: 4, direction: 'normal', operation: 'new' },
        ],
      }
      const r1 = h.run(doc)
      expect((r1.result as Record<string, Record<string, unknown>>)['fi1'].status).toBe('ok')

      // Pick boundary right after the import: body_imp1 there is UNFILLETED,
      // while the mesh the reuse path could offer is the filleted one.
      h.rendered = []
      const r2 = h.run(doc, { prevState: r1._build_state, pickBoundary: 1 })
      const pick = r2.pick_bodies as Record<string, Record<string, unknown>>
      expect(Object.keys(pick)).toContain('body_imp1')
      expect(h.rendered).toContain('body_imp1')
      // The point of the guard, stated as geometry rather than as a call count:
      // the pick world must not be handed the modified shape.
      expect(pick['body_imp1'].mesh).not.toEqual(h.body(r2, 'body_imp1').mesh)
    })
  })
})
