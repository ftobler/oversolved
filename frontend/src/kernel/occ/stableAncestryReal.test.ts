// @vitest-environment node
//
// Gated real-OCC parity tests for stable ancestry — geometry hash stability
// across builds and edits (ported from test_stable_ancestry.py). Verifies that
// face/edge geometry hashes are identical when the same shape is built twice,
// and that a fillet operation changes face hashes while inherited ones stay.
//
// Skips when opencascade.js is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import { HandleTable } from './handleTable'
import { makeBox } from './primitives'
import { booleanWithHistory } from './booleans'
import { solidToMesh, solidToEdges, solidToVertices } from './tessellation'
import { brepDiffNewFaceHashes, brepDiffNewEdgeHashes, brepDiffNewVertexHashes } from './brepDiffHash'
import { faceGeometryHash } from '../geomHash'
import { build, repoFromSnapshot, type BuildDeps } from '../builder'
import { initGlobalRepo, makeAncestryQuery } from '../query'
import { createFeatureSolver } from '../solverRegistry'
import { postRegister } from '../features/postRegister'
import { setSketchSolver, resetSketchSolver } from '../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import type { OccModule } from './occTypes'

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
  return { features: [rectSketch('sk1', w, h), { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: d, direction: 'normal', operation: 'new' }] }
}

function runBuild(spec: Record<string, unknown>) {
  const scope = new DisposeScope()
  const table = new HandleTable({ finalizerGuard: false })
  try {
    const deps: BuildDeps = {
      trySolveFeature: createFeatureSolver(oc!, scope, table),
      postRegister, initGlobalRepo,
      tessellateBodies: (bodyStore) => {
        const out: Record<string, Record<string, unknown>> = {}
        for (const [, body] of Object.entries(bodyStore)) {
          if (!body.shape) continue
          try {
            const mesh = solidToMesh(oc!, table, body.shape, {
              createdBy: body.created_by || '', bodyId: body.id,
              faceLineage: body.face_lineage ?? null, profileQueries: body.profile_queries ?? [],
            })
            const edgeResult = solidToEdges(oc!, table, body.shape, {
              createdBy: body.created_by || '', bodyId: body.id,
              profileQueries: body.profile_queries ?? [], edgeLineage: body.edge_lineage ?? null,
            })
            const vertexResult = solidToVertices(oc!, table, body.shape, {
              createdBy: body.created_by || '', bodyId: body.id,
              profileQueries: body.profile_queries ?? [],
            })
            out[body.id] = {
              mesh, edges: edgeResult.edges, edge_queries: edgeResult.edge_queries,
              vertices: vertexResult.vertices, vertex_queries: vertexResult.vertex_queries,
            }
          } catch { /* non-fatal */ }
        }
        return out
      },
      brepDiffNewFaceHashes: (b) => brepDiffNewFaceHashes(oc!, scope, b),
      brepDiffNewEdgeHashes: (b) => brepDiffNewEdgeHashes(oc!, scope, b),
      brepDiffNewVertexHashes: (b) => brepDiffNewVertexHashes(oc!, scope, b),
    }
    const result = build(spec, {}, deps)
    scope.dispose()
    return result
  } catch (e) {
    scope.dispose()
    throw e
  }
}

function lastCheckpoint(result: ReturnType<typeof runBuild>) {
  const state = result._build_state!
  const lastFid = state.feature_order[state.feature_order.length - 1]
  return state.checkpoints[lastFid]
}

function findByGeomHash(snapshot: Record<string, unknown>, prefix: string): Set<string> {
  const byGeomHash = snapshot.byGeomHash as Record<string, string[]> | undefined
  if (!byGeomHash) return new Set()
  return new Set(Object.keys(byGeomHash).filter((h) => h.startsWith(prefix)))
}

describe.skipIf(!oc)('stable ancestry hash stability (OCC-level)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  function tessellateFaces(shape: ReturnType<typeof booleanWithHistory>['shape']) {
    const table = new HandleTable({ finalizerGuard: false })
    const handle = table.register(shape, 'test')
    const mesh = solidToMesh(occ, table, handle)
    return mesh.face_data.map((fd) => faceGeometryHash(fd.centroid, fd.normal))
  }

  it('identical box builds produce identical face hashes', () => {
    const scope1 = new DisposeScope()
    const scope2 = new DisposeScope()
    try {
      const box1 = makeBox(occ, scope1, 10, 10, 10)
      const box2 = makeBox(occ, scope2, 10, 10, 10)
      const hashes1 = tessellateFaces(box1).sort()
      const hashes2 = tessellateFaces(box2).sort()
      expect(hashes1).toEqual(hashes2)
    } finally {
      scope1.dispose()
      scope2.dispose()
    }
  })

  it('cut result has more face hashes than the original box', () => {
    const scope = new DisposeScope()
    try {
      const target = makeBox(occ, scope, 10, 10, 10)
      const tool = makeBox(occ, scope, 4, 4, 4)
      const { shape } = booleanWithHistory(occ, scope, target, tool, 'cut')
      const cutHashes = tessellateFaces(shape)
      expect(cutHashes.length).toBeGreaterThan(6)
    } finally {
      scope.dispose()
    }
  })

  it('face hashes are non-empty and well-formed', () => {
    const scope = new DisposeScope()
    try {
      const box = makeBox(occ, scope, 10, 10, 10)
      const hashes = tessellateFaces(box)
      for (const h of hashes) {
        expect(h.startsWith('gface_')).toBe(true)
        expect(h.length).toBeGreaterThan('gface_'.length)
      }
    } finally {
      scope.dispose()
    }
  })

  it('box has 6 distinct face hashes (one per side)', () => {
    const scope = new DisposeScope()
    try {
      const box = makeBox(occ, scope, 10, 10, 10)
      const hashes = tessellateFaces(box)
      expect(hashes.length).toBe(6)
      expect(new Set(hashes).size).toBe(6)
    } finally {
      scope.dispose()
    }
  })
})

describe.skipIf(!oc || !solveBytes)('stable ancestry build-level (real OCC + Rust solver)', () => {
  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  it('face hashes are registered in repo byGeomHash after extrude', () => {
    /** Face hashes appear in by_geom_hash in the repo snapshot. Port of
     *  test_face_registration_has_hash_tag. */
    const r = runBuild(fullRectExtrudeSpec(10, 10, 5))
    const ckp = lastCheckpoint(r)
    expect(ckp).toBeDefined()
    const snapshot = ckp!.repo_snapshot as Record<string, unknown>
    const faceHashes = findByGeomHash(snapshot, 'gface_')
    expect(faceHashes.size).toBeGreaterThan(0)
  })

  it('edge hashes are registered in repo byGeomHash after extrude', () => {
    /** Edge hashes appear in by_geom_hash. Port of test_edge_registration_has_hash_tag. */
    const r = runBuild(fullRectExtrudeSpec(10, 10, 5))
    const ckp = lastCheckpoint(r)
    expect(ckp).toBeDefined()
    const snapshot = ckp!.repo_snapshot as Record<string, unknown>
    const edgeHashes = findByGeomHash(snapshot, 'gedge_')
    expect(edgeHashes.size).toBeGreaterThan(0)
  })

  it('vertex hashes are registered in repo byGeomHash after extrude', () => {
    /** Vertex hashes appear in by_geom_hash. Port of test_vetex_registration_has_gvertex_tag. */
    const r = runBuild(fullRectExtrudeSpec(10, 10, 5))
    const ckp = lastCheckpoint(r)
    expect(ckp).toBeDefined()
    const snapshot = ckp!.repo_snapshot as Record<string, unknown>
    const vertexHashes = findByGeomHash(snapshot, 'gvertex_')
    expect(vertexHashes.size).toBeGreaterThan(0)
  })

  it('face registrations have at least 3 structural tags', () => {
    /** Each face registration key must have >=3 structural tags
     *  (index, feature, body). Port of test_face_registration_has_4_tags. */
    const r = runBuild(fullRectExtrudeSpec(10, 10, 5))
    const ckp = lastCheckpoint(r)
    expect(ckp).toBeDefined()
    const snapshot = ckp!.repo_snapshot as Record<string, unknown>
    const ancestral = snapshot.ancestral as Record<string, { eids?: string[] }> | undefined
    expect(ancestral).toBeDefined()
    let found = 0
    for (const key of Object.keys(ancestral!)) {
      if (key.includes('/face')) {
        // TS kernel joins ancestorIds with \\0 separator.
        const parts = key.split('\0')
        expect(parts.length).toBeGreaterThanOrEqual(3)
        found++
      }
    }
    expect(found).toBeGreaterThan(0)
  })

  it('old 3-tag query still resolves against repo', () => {
    /** Legacy queries with just index-tag + feature + body still resolve.
     *  Port of test_old_3tag_query_still_resolves. */
    const r = runBuild(fullRectExtrudeSpec(10, 10, 5))
    const mesh = (r.bodies as Record<string, { mesh?: { face_queries?: string[] } }>)['body_ex1']?.mesh
    const faceQueries = mesh?.face_queries ?? []
    expect(faceQueries.length).toBeGreaterThan(0)

    const ckp = lastCheckpoint(r)
    expect(ckp).toBeDefined()
    const repo = repoFromSnapshot(ckp!.repo_snapshot as Record<string, unknown>)

    for (let idx = 0; idx < faceQueries.length; idx++) {
      const old3tag = makeAncestryQuery([`@body_ex1/face${idx}`, '@ex1', '@body_ex1'], null)
      const resolved = repo.query(old3tag) as { body_id?: string } | null
      if (resolved) {
        expect(typeof resolved).toBe('object')
        expect(resolved.body_id).toBe('body_ex1')
        return
      }
    }
    throw new Error('No face query resolved against the repo')
  })

  it('face hashes are stable across identical builds', () => {
    /** Same spec built twice produces identical face hashes. Port of
     *  test_hash_stable_across_same_builds. */
    const r1 = runBuild(fullRectExtrudeSpec(10, 10, 5))
    const r2 = runBuild(fullRectExtrudeSpec(10, 10, 5))
    const ckp1 = lastCheckpoint(r1)
    const ckp2 = lastCheckpoint(r2)
    expect(ckp1).toBeDefined()
    expect(ckp2).toBeDefined()
    const h1 = findByGeomHash(ckp1!.repo_snapshot as Record<string, unknown>, 'gface_')
    const h2 = findByGeomHash(ckp2!.repo_snapshot as Record<string, unknown>, 'gface_')
    expect(h1.size).toBeGreaterThan(0)
    expect(h2.size).toBeGreaterThan(0)
    expect(h1).toEqual(h2)
  })

  it('some face hashes survive fillet unchanged', () => {
    /** Fillet introduces new faces but unchanged ones keep their hash. Port of
     *  test_hash_shared_across_fillet. */
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const rBefore = runBuild(spec)
    const ckpBefore = lastCheckpoint(rBefore)
    expect(ckpBefore).toBeDefined()
    const hashesBefore = findByGeomHash(ckpBefore!.repo_snapshot as Record<string, unknown>, 'gface_')

    spec.features.push({ id: 'fillet1', kind: 'fillet', edges: ['?body_ex1:edge:0'], radius: 1 })
    const rAfter = runBuild(spec)
    const ckpAfter = lastCheckpoint(rAfter)
    expect(ckpAfter).toBeDefined()
    const hashesAfter = findByGeomHash(ckpAfter!.repo_snapshot as Record<string, unknown>, 'gface_')

    const shared = new Set([...hashesBefore].filter((h) => hashesAfter.has(h)))
    expect(shared.size).toBeGreaterThan(0)
  })

  it('fillet introduces new face hashes', () => {
    /** Fillet adds cylindrical faces with new hashes. Port of
     *  test_new_face_hashes_appear_after_fillet. */
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const rBefore = runBuild(spec)
    const ckpBefore = lastCheckpoint(rBefore)
    expect(ckpBefore).toBeDefined()
    const hashesBefore = findByGeomHash(ckpBefore!.repo_snapshot as Record<string, unknown>, 'gface_')

    spec.features.push({ id: 'fillet1', kind: 'fillet', edges: ['?body_ex1:edge:0'], radius: 3 })
    const rAfter = runBuild(spec)
    const ckpAfter = lastCheckpoint(rAfter)
    expect(ckpAfter).toBeDefined()
    const hashesAfter = findByGeomHash(ckpAfter!.repo_snapshot as Record<string, unknown>, 'gface_')

    const newHashes = new Set([...hashesAfter].filter((h) => !hashesBefore.has(h)))
    expect(newHashes.size).toBeGreaterThan(0)
  })

  it('fillet increases total face count', () => {
    /** Fillet adds cylindrical faces. Port of test_fillet_introduces_more_faces. */
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const rBefore = runBuild(spec)
    const ckpBefore = lastCheckpoint(rBefore)
    expect(ckpBefore).toBeDefined()
    const beforeCount = findByGeomHash(ckpBefore!.repo_snapshot as Record<string, unknown>, 'gface_').size

    spec.features.push({ id: 'fillet1', kind: 'fillet', edges: ['?body_ex1:edge:0'], radius: 3 })
    const rAfter = runBuild(spec)
    const ckpAfter = lastCheckpoint(rAfter)
    expect(ckpAfter).toBeDefined()
    const afterCount = findByGeomHash(ckpAfter!.repo_snapshot as Record<string, unknown>, 'gface_').size

    expect(afterCount).toBeGreaterThan(beforeCount)
  })

  it('face payload includes created_by field', () => {
    /** Every face element in the repo must have created_by set. Port of
     *  test_registered_face_payload_has_created_by. */
    const r = runBuild(fullRectExtrudeSpec(10, 10, 5))
    const ckp = lastCheckpoint(r)
    expect(ckp).toBeDefined()
    const snapshot = ckp!.repo_snapshot as Record<string, unknown>
    const elements = snapshot.elements as Record<string, Record<string, unknown>> | undefined
    const ancestral = snapshot.ancestral as Record<string, { eids: string[] }> | undefined
    expect(elements).toBeDefined()
    expect(ancestral).toBeDefined()

    let found = 0
    for (const [, entry] of Object.entries(ancestral!)) {
      for (const eid of entry.eids ?? []) {
        const el = elements?.[eid]
        if (el && el.body_id && !el.origin) {  // skip sketch-plane elements (they have origin)
          expect(el.created_by).toBeDefined()
          found++
        }
      }
    }
    expect(found).toBeGreaterThan(0)
  })
})
