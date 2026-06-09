// @vitest-environment node
//
// Shared test harness for multi-build Real OCC tests (persistent HandleTable).
//
// Each test suite creates one HandleTable and one run() function per-spec;
// the table survives across builds so OccHandles from a prior build's
// prevState remain valid for the next build. A fresh DisposeScope is created
// per build (transient builders/explorers).

import type { OccModule } from '../occ/occTypes'
import { DisposeScope } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import {
  type BuildResponse,
  type BuildDeps,
  build,
} from '../builder'
import type { BuildState } from '../types3d'
import { initGlobalRepo } from '../query'
import { createFeatureSolver } from '../solverRegistry'
import { postRegister } from '../features/postRegister'
import { solidToMesh, solidToEdges, solidToVertices } from '../occ/tessellation'
import { extractBrepMetadata } from '../solveLocally'
import { brepDiffNewFaceHashes, brepDiffNewEdgeHashes, brepDiffNewVertexHashes } from '../occ/brepDiffHash'
import { copyShape } from '../occ/transforms'
import type { OccShape } from '../occ/occTypes'

export class SharedHarness {
  readonly oc: OccModule
  readonly table = new HandleTable({ finalizerGuard: false })

  constructor(oc: OccModule) { this.oc = oc }

  run(
    spec: Record<string, unknown>,
    opts?: { prevState?: BuildState | null; pickBoundary?: number | null; rollbackPosition?: number | null },
  ): BuildResponse {
    const scope = new DisposeScope()
    try {
      const deps: BuildDeps = {
        trySolveFeature: createFeatureSolver(this.oc, scope, this.table),
        postRegister, initGlobalRepo,
        tessellateBodies: (bodyStore) => {
          const out: Record<string, Record<string, unknown>> = {}
          for (const [, body] of Object.entries(bodyStore)) {
            if (!body.shape) continue
            try {
              const mesh = solidToMesh(this.oc, this.table, body.shape, {
                createdBy: body.created_by || '',
                bodyId: body.id,
                faceLineage: body.face_lineage ?? null,
                profileQueries: body.profile_queries ?? [],
              })
              const edgeResult = solidToEdges(this.oc, this.table, body.shape, {
                createdBy: body.created_by || '',
                bodyId: body.id,
                profileQueries: body.profile_queries ?? [],
                edgeLineage: body.edge_lineage ?? null,
              })
              const vertexResult = solidToVertices(this.oc, this.table, body.shape, {
                createdBy: body.created_by || '',
                bodyId: body.id,
                profileQueries: body.profile_queries ?? [],
              })
              out[body.id] = {
                mesh,
                edges: edgeResult.edges,
                edge_queries: edgeResult.edge_queries,
                vertices: vertexResult.vertices,
                vertex_queries: vertexResult.vertex_queries,
              }
            } catch { /* non-fatal */ }
          }
          return out
        },
        // Wire the real production metadata extractor so the build-level tests
        // exercise the mesh-free in-loop registration path (not the fallback).
        extractBrepMetadata: (bodyStore) => extractBrepMetadata(this.oc, this.table, bodyStore),
        brepDiffNewFaceHashes: (b) => brepDiffNewFaceHashes(this.oc, scope, b),
        brepDiffNewEdgeHashes: (b) => brepDiffNewEdgeHashes(this.oc, scope, b),
        brepDiffNewVertexHashes: (b) => brepDiffNewVertexHashes(this.oc, scope, b),
        retainCheckpointShape: (h, owner) => this.table.retain(h, owner),
        copyBodyShape: (h) => this.table.register(copyShape(this.oc, scope, this.table.get<OccShape>(h))),
        releaseCheckpoint: (fid) => this.table.releaseOwner('cp:' + fid),
      }
      return build(spec, {
        prevState: opts?.prevState ?? null,
        pickBoundary: opts?.pickBoundary ?? null,
        rollbackPosition: opts?.rollbackPosition ?? null,
      }, deps)
    } finally {
      scope.dispose()
    }
  }

  res(result: BuildResponse, featureId: string): Record<string, unknown> {
    return (result.result as Record<string, Record<string, unknown>>)[featureId] ?? {}
  }

  body(result: BuildResponse, bodyId: string): Record<string, unknown> {
    return (result.bodies as Record<string, Record<string, unknown>>)[bodyId] ?? {}
  }
}
