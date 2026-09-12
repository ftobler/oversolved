// @vitest-environment node
//
// Settles the one question `double-registration-pass` could not answer without OCC: may
// the FINAL checkpoint skip its registration pass like every other one?
//
// Every other checkpoint identifies off `extractBrepMetadata` (mesh-free), exactly what
// the feature loop used, so "the loop already registered this body version" is trivially
// true. The final checkpoint instead reuses the RENDER tessellation (`tessellateBodies`)
// for both its display snapshot and its ancestry -- a different producer. The metadata
// path keeps zero-triangle faces while `assembleMesh` drops them (occ/tessellation.ts),
// so face INDEX agreement is a real invariant, not a given, and face indices are both a
// payload field and part of the ancestral key.
//
// This test registers one body twice into two fresh repos, once per producer, and
// compares the eid-free fingerprints. Equal => the final checkpoint may skip too.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './occ/loadOcc'
import { DisposeScope } from './occ/disposeScope'
import { HandleTable } from './occ/handleTable'
import { build, registerBodyBrepFromMeta, snapshotRepo, RESTORE_OWNER, type BuildDeps, type BuildResponse } from './builder'
import { Repository, initGlobalRepo } from './query'
import { createFeatureSolver } from './solverRegistry'
import { postRegister } from './features/postRegister'
import { extractBrepMetadata, tessellateBodies } from './solveLocally'
import { brepDiffNewFaceHashes, brepDiffNewEdgeHashes, brepDiffNewVertexHashes } from './occ/brepDiffHash'
import { copyShape } from './occ/transforms'
import type { OccShape } from './occ/occTypes'
import { setSketchSolver, resetSketchSolver } from './features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { repoSemanticFingerprint } from './repoFingerprintTestUtil'
import type { Body } from './types3d'
import importFixture from './occ/__fixtures__/importStep.json'
import { base64ToBytes } from './occ/stepIo'

const oc = await loadOcc()
const solveBytes = loadSolver()
const importFx = importFixture as unknown as { file_data: string }
const importFiles = new Map<string, Uint8Array>([['imp1', base64ToBytes(importFx.file_data)]])

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

// Solves a document with the production deps and keeps the handle table alive, so the
// final checkpoint's retained shapes stay readable after the build returns.
class Harness {
  readonly table = new HandleTable({ finalizerGuard: false })

  run(spec: Record<string, unknown>, files?: ReadonlyMap<string, Uint8Array>): BuildResponse {
    const scope = new DisposeScope()
    try {
      const deps: BuildDeps = {
        trySolveFeature: createFeatureSolver(oc!, scope, this.table, files),
        postRegister, initGlobalRepo,
        tessellateBodies: (bodyStore) => tessellateBodies(oc!, this.table, bodyStore),
        extractBrepMetadata: (bodyStore) => extractBrepMetadata(oc!, this.table, bodyStore),
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
      return build(spec, { prevState: null, pickBoundary: null, rollbackPosition: null }, deps)
    } finally {
      scope.dispose()
    }
  }

  // The body as the final checkpoint holds it (retained shape, live handle).
  finalBody(r: BuildResponse, bodyId: string): Body {
    const order = r._build_state.feature_order
    const cp = r._build_state.checkpoints[order[order.length - 1]]
    return cp.body_store_snapshot[bodyId]
  }

  // Fingerprint of a repo holding only this body's B-rep ancestry, per producer.
  fingerprints(body: Body): { meta: string; render: string; faceCounts: [number, number] } {
    const scope = new DisposeScope()
    try {
      const deps = {
        brepDiffNewFaceHashes: (b: Body) => brepDiffNewFaceHashes(oc!, scope, b),
        brepDiffNewEdgeHashes: (b: Body) => brepDiffNewEdgeHashes(oc!, scope, b),
        brepDiffNewVertexHashes: (b: Body) => brepDiffNewVertexHashes(oc!, scope, b),
      } as BuildDeps
      const metaOut = extractBrepMetadata(oc!, this.table, { [body.id]: body })[body.id]
      const renderOut = tessellateBodies(oc!, this.table, { [body.id]: body })[body.id]
      const repoMeta = new Repository()
      registerBodyBrepFromMeta(repoMeta, body, metaOut, deps)
      const repoRender = new Repository()
      registerBodyBrepFromMeta(repoRender, body, renderOut, deps)
      const faces = (out: Record<string, unknown>): number =>
        ((out.mesh as { face_data: unknown[] }).face_data ?? []).length
      return {
        meta: repoSemanticFingerprint(snapshotRepo(repoMeta)),
        render: repoSemanticFingerprint(snapshotRepo(repoRender)),
        faceCounts: [faces(metaOut), faces(renderOut)],
      }
    } finally {
      scope.dispose()
    }
  }
}

describe.skipIf(!oc || !solveBytes)('checkpoint registration: metadata vs render mesh (real OCC)', () => {
  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver(); setSketchSolver(solveBytes)
  })

  it('an extruded solid registers identically off metadata and off the render mesh', () => {
    const h = new Harness()
    const r = h.run({ features: [
      rectSketch('sk1', 20, 20),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'add' },
    ] })
    expect((r.result as Record<string, Record<string, unknown>>).ex1.status).toBe('ok')
    const fp = h.fingerprints(h.finalBody(r, 'body_ex1'))
    expect(fp.meta).toContain('flatface')  // not vacuous: real payloads on both sides
    expect(fp.faceCounts[0]).toBe(6)
    expect(fp.faceCounts[1]).toBe(fp.faceCounts[0])
    expect(fp.render).toEqual(fp.meta)
  })

  it('an imported STEP body registers identically off metadata and off the render mesh', () => {
    const h = new Harness()
    const r = h.run({ features: [
      { id: 'imp1', kind: 'import_step', file_id: 'imp1', scale: 1 },
    ] }, importFiles)
    expect((r.result as Record<string, Record<string, unknown>>).imp1.status).toBe('ok')
    const fp = h.fingerprints(h.finalBody(r, 'body_imp1'))
    expect(fp.meta).toContain('face_index')  // not vacuous: real payloads on both sides
    expect(fp.faceCounts[0]).toBeGreaterThan(0)
    expect(fp.faceCounts[1]).toBe(fp.faceCounts[0])
    expect(fp.render).toEqual(fp.meta)
  })
})
