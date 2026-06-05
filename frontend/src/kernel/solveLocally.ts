/**
 * Live TS kernel solve pipeline (phase 4a).
 *
 * ``solveLocally`` loads OCC.js lazily, wires the builder deps (feature solver
 * adapter, tessellation, repository), calls ``build()``, and returns a
 * ``BuildResponse`` compatible with the existing ``applySolveResult`` path.
 * When OCC.js is unavailable it returns ``null`` so the caller can fall back
 * to the Python WebSocket.
 */

import { build, type BuildDeps, type BuildResponse } from './builder'
import { Repository } from './query'
import { createFeatureSolver } from './solverRegistry'
import { initSketchSolver } from './features/sketch'
import { loadOccWeb } from './occ/loadOccWeb'
import { DisposeScope } from './occ/disposeScope'
import { HandleTable } from './occ/handleTable'
import { solidToMesh, solidToEdges, solidToVertices } from './occ/tessellation'
import type { OccModule } from './occ/occTypes'
import type { Body } from './types3d'

let occModule: OccModule | null = null
let occLoading: Promise<OccModule | null> | null = null

/** Load (or return the already-loaded) OCC module. */
async function ensureOcc(): Promise<OccModule | null> {
  if (occModule) return occModule
  if (!occLoading) {
    console.log('[solveLocally] calling loadOccWeb()')
    occLoading = loadOccWeb().then((m) => {
      occModule = m
      console.log('[solveLocally] loadOccWeb resolved:', m ? 'module OK' : 'null')
      return m
    })
  }
  return occLoading
}

/**
 * Tessellate every body in the store and return per-body mesh/edge/vertex
 * data. Used as ``BuildDeps.tessellateBodies``.
 */
function tessellateBodies(
  oc: OccModule,
  table: HandleTable,
  bodyStore: Record<string, Body>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [bodyId, body] of Object.entries(bodyStore)) {
    if (body.shape == null) continue
    try {
      const mesh = solidToMesh(oc, table, body.shape, {
        createdBy: body.created_by || '',
        bodyId: body.id,
        faceLineage: body.face_lineage ?? null,
        profileQueries: body.profile_queries ?? [],
      })
      const edges = solidToEdges(oc, table, body.shape)
      const vertices = solidToVertices(oc, table, body.shape)
      out[bodyId] = { mesh, edges, vertices }
    } catch {
      // Non-fatal: a body that fails to tessellate still has valid topology.
    }
  }
  return out
}

/**
 * Solve a document locally through the TS/WASM kernel.
 *
 * Returns the ``BuildResponse`` on success, or ``null`` when OCC.js is not
 * available (caller should fall back to Python WebSocket).
 */
export async function solveLocally(
  spec: Record<string, unknown>,
  options: {
    prevState?: BuildResponse['_build_state'] | null
    pickBoundary?: number | null
    rollbackPosition?: number | null
    validate?: boolean
  } = {},
): Promise<BuildResponse | null> {
  console.log('[solveLocally] attempting local solve for doc')
  const oc = await ensureOcc()
  if (!oc) {
    console.log('[solveLocally] OCC.js not available, returning null (fallback to Python)')
    return null
  }
  console.log('[solveLocally] OCC.js loaded, running build()')

  // Pre-load the Rust sketch solver (fire-and-forget — if absent, sketch
  // features will throw and the builder catches them).
  void initSketchSolver()

  const scope = new DisposeScope()
  const table = new HandleTable({ finalizerGuard: false })

  try {
    const deps: BuildDeps = {
      trySolveFeature: createFeatureSolver(oc, scope, table),
      postRegister: () => {
        // no-op: the builder handles brep ancestry registration in
        // _snapshotWithBrepGeometry after tessellation.
      },
      initGlobalRepo: () => new Repository(),
      tessellateBodies: (bodyStore, _repo) => tessellateBodies(oc, table, bodyStore),
    }

    const specForBuild = options.validate
      ? { ...spec, _validate: true }
      : spec

    return build(specForBuild, {
      prevState: options.prevState ?? null,
      pickBoundary: options.pickBoundary ?? null,
      rollbackPosition: options.rollbackPosition ?? null,
    }, deps)
  } finally {
    scope.dispose()
    // HandleTable lives across builds; checkpoint eviction releases handles.
    // For now every solve creates a fresh table — acceptable until the Worker
    // holds the long-lived table across solves.
  }
}
