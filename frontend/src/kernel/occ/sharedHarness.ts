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
  RESTORE_OWNER,
} from '../builder'
import type { BuildState } from '../types3d'
import { initGlobalRepo } from '../query'
import { createFeatureSolver } from '../solverRegistry'
import { postRegister } from '../features/postRegister'
import { solidToMesh, solidToEdges, solidToVertices } from '../occ/tessellation'
import { extractBrepMetadata } from '../solveLocally'
import { brepDiffNewFaceHashes, brepDiffNewEdgeHashes, brepDiffNewVertexHashes } from '../occ/brepDiffHash'
import { copyShape } from '../occ/transforms'
import { assertOneSolidPerBody } from '../features/bodySplit'
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
      return build(spec, {
        prevState: opts?.prevState ?? null,
        pickBoundary: opts?.pickBoundary ?? null,
        rollbackPosition: opts?.rollbackPosition ?? null,
      }, this.makeDeps(scope, this.table))
    } finally {
      scope.dispose()
    }
  }

  /**
   * Wire the builder deps for one scope/table pair. Parameterized so the
   * ``_validate`` comparison build can receive identical wiring bound to
   * throwaway resources instead of the harness's persistent table -- mirroring
   * the production ``buildDeps`` in solveLocally.
   */
  private makeDeps(scope: DisposeScope, table: HandleTable): BuildDeps {
    return {
      trySolveFeature: createFeatureSolver(this.oc, scope, table),
      postRegister, initGlobalRepo,
      tessellateBodies: (bodyStore) => {
        // The one-Body-one-solid gate, at the point every real-OCC build test
        // already passes through: a leaf that produces a multi-solid body
        // fails its own test rather than shipping one Parts row that is
        // really N parts. See features/bodySplit.ts.
        assertOneSolidPerBody(this.oc, scope, table, bodyStore)
        const out: Record<string, Record<string, unknown>> = {}
        for (const [, body] of Object.entries(bodyStore)) {
          if (!body.shape) continue
          try {
            const mesh = solidToMesh(this.oc, table, body.shape, {
              createdBy: body.created_by || '',
              bodyId: body.id,
              faceAncestry: body.face_ancestry ?? null,
              faceNames: body.face_names ?? null,
              profileQueries: body.profile_queries ?? [],
            })
            const edgeResult = solidToEdges(this.oc, table, body.shape, {
              createdBy: body.created_by || '',
              bodyId: body.id,
              profileQueries: body.profile_queries ?? [],
              edgeAncestry: body.edge_ancestry ?? null,
              edgeNames: body.edge_names ?? null,
              brepDiff: body.brep_diff ?? null,
              modifiedBy: body.modified_by,
            })
            const vertexResult = solidToVertices(this.oc, table, body.shape, {
              createdBy: body.created_by || '',
              bodyId: body.id,
              profileQueries: body.profile_queries ?? [],
              faceNames: body.face_names ?? null,
            })
            out[body.id] = {
              mesh,
              edges: edgeResult.edges,
              edge_queries: edgeResult.edge_queries,
              vertices: vertexResult.vertices,
              vertex_queries: vertexResult.vertex_queries,
              vertex_uuids: vertexResult.vertex_uuids,
            }
          } catch {  /* non-fatal */ }
        }
        return out
      },
      // Wire the real production metadata extractor so the build-level tests
      // exercise the mesh-free in-loop registration path (not the fallback).
      extractBrepMetadata: (bodyStore) => extractBrepMetadata(this.oc, table, bodyStore),
      brepDiffNewFaceHashes: (b) => brepDiffNewFaceHashes(this.oc, scope, b),
      brepDiffNewEdgeHashes: (b) => brepDiffNewEdgeHashes(this.oc, scope, b),
      brepDiffNewVertexHashes: (b) => brepDiffNewVertexHashes(this.oc, scope, b),
      retainCheckpointShape: (h, owner) => table.retain(h, owner),
      copyBodyShape: (h, owner) =>
        table.register(copyShape(this.oc, scope, table.get<OccShape>(h)), owner),
      // Mirrors the production wiring: a discarded generation loses its
      // checkpoint retain AND its base body registrations (bodySplit tags
      // those with the producing feature id) -- or superseded solids strand
      // across an incremental test sequence.
      releaseCheckpoint: (fid) => {
        table.releaseOwner('cp:' + fid)
        table.releaseOwner(fid)
      },
      releaseRestoreCopies: () => table.releaseOwner(RESTORE_OWNER),
      // Production parity: the validation build owns a full second generation
      // it discards afterwards, so it must not mint it into `table`.
      isolatedValidationDeps: () => {
        const isoScope = new DisposeScope()
        const isoTable = new HandleTable({ finalizerGuard: false })
        return {
          deps: this.makeDeps(isoScope, isoTable),
          dispose: () => {
            isoScope.dispose()
            isoTable.disposeAll()
          },
        }
      },
    }
  }

  res(result: BuildResponse, featureId: string): Record<string, unknown> {
    return (result.result as Record<string, Record<string, unknown>>)[featureId] ?? {}
  }

  body(result: BuildResponse, bodyId: string): Record<string, unknown> {
    return (result.bodies as Record<string, Record<string, unknown>>)[bodyId] ?? {}
  }
}
