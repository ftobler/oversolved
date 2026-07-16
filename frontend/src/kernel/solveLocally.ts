/**
 * Live TS kernel solve pipeline (phase 4a).
 *
 * ``solveLocally`` loads OCC.js lazily, wires the builder deps (feature solver
 * adapter, tessellation, repository), calls ``build()``, and returns a
 * ``BuildResponse`` compatible with the existing ``applySolveResult`` path.
 * When OCC.js is unavailable it returns ``null``.
 */

import { build, type BuildDeps, type BuildResponse } from './builder'
import { initGlobalRepo } from './query'
import { createFeatureSolver } from './solverRegistry'
import { initSketchSolver } from './features/sketch'
import { postRegister } from './features/postRegister'
import { loadOccWeb } from './occ/loadOccWeb'
import { DisposeScope } from './occ/disposeScope'
import { HandleTable } from './occ/handleTable'
import { solidToMesh, solidToEdges, solidToVertices, solidToFaceEdgeQueries, readShapeFaceMetadata } from './occ/tessellation'
import type { TessMesh } from './occ/tessellation'
import { brepDiffNewFaceHashes, brepDiffNewEdgeHashes, brepDiffNewVertexHashes } from './occ/brepDiffHash'
import { copyShape } from './occ/transforms'
import { stepShapeToBytes, shapeToStlBytes } from './occ/stepIo'
import type { OccModule, OccShape } from './occ/occTypes'
import type { Body, BuildState } from './types3d'

let occModule: OccModule | null = null
let occLoading: Promise<OccModule | null> | null = null

// ─── cross-solve checkpoint cache ───
// The checkpoint cache is not a side table: it IS the OCC handles in this
// HandleTable plus the BuildState that points at them. The table must outlive a
// single solve so the clean-prefix bodies' OCC shapes survive into the next
// build() (mirroring the SharedHarness pattern proven by meshCacheReal.test).
// A fresh table per solve (the old behaviour) left every prior handle dangling,
// so findFirstDirty could never reuse a checkpoint and every edit rebuilt the
// whole stack. Keyed by doc id; switching documents discards the old table.
let persistentTable: HandleTable | null = null
let lastBuildState: BuildState | null = null
let lastDocId: string | null = null

/** Drop the cross-solve cache (handles + state). Called on doc switch. */
function resetLocalSolveCache(): void {
  persistentTable?.disposeAll()
  persistentTable = null
  lastBuildState = null
  lastDocId = null
}

// Loader seam. Default is loadOccWeb (main-thread DOM loader); the Worker
// bootstrap installs the DOM-free loadOccWorker; tests inject the node
// MEMFS-backed module to drive the real production entry off-thread.
let occLoaderOverride: (() => Promise<OccModule | null>) | null = null

/**
 * Install the OCC loader. The Worker bootstrap calls this with the DOM-free
 * worker loader; without it the main-thread loadOccWeb is used.
 */
export function setOccLoader(loader: (() => Promise<OccModule | null>) | null): void {
  occLoaderOverride = loader
  occModule = null
  occLoading = null
}

/** @internal test-only: inject an OCC loader and reset all cached state. */
export function setSolveLocalsForTest(
  loader: (() => Promise<OccModule | null>) | null,
): void {
  setOccLoader(loader)
  resetLocalSolveCache()
}

/** Load (or return the already-loaded) OCC module. */
async function ensureOcc(): Promise<OccModule | null> {
  if (occModule) return occModule
  if (!occLoading) {
    const loader = occLoaderOverride ?? loadOccWeb
    occLoading = loader().then((m) => {
      occModule = m
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
        faceAncestry: body.face_ancestry ?? null,
        faceNames: body.face_names ?? null,
        profileQueries: body.profile_queries ?? [],
      })
      const edgeResult = solidToEdges(oc, table, body.shape, {
        createdBy: body.created_by || '',
        bodyId: body.id,
        profileQueries: body.profile_queries ?? [],
        edgeAncestry: body.edge_ancestry ?? null,
        edgeNames: body.edge_names ?? null,
      })
      const vertexResult = solidToVertices(oc, table, body.shape, {
        createdBy: body.created_by || '',
        bodyId: body.id,
        profileQueries: body.profile_queries ?? [],
      })
      // Per-face boundary edge queries: a face pick projects as a closed wire.
      mesh.face_edge_queries = solidToFaceEdgeQueries(oc, table, body.shape, edgeResult.edge_queries)
      out[bodyId] = {
        mesh,
        edges: edgeResult.edges,
        edge_queries: edgeResult.edge_queries,
        vertices: vertexResult.vertices,
        vertex_queries: vertexResult.vertex_queries,
      }
    } catch {
      // Non-fatal: a body that fails to tessellate still has valid topology.
    }
  }
  return out
}

/**
 * Mesh-free B-rep identification for every body in the store: face
 * centroid/normal/surface_type/classifiers + face/edge/vertex ancestry queries,
 * with NO triangulation. Used as ``BuildDeps.extractBrepMetadata`` so the
 * feature loop registers ancestry off the B-rep alone; the expensive
 * ``solidToMesh`` runs once post-loop for rendering. The returned shape matches
 * ``tessellateBodies`` (a ``mesh`` with empty geometry arrays but populated
 * ``face_data``/``face_queries``) so the builder's registration path is
 * identical whether it is handed metadata or a full mesh.
 */
export function extractBrepMetadata(
  oc: OccModule,
  table: HandleTable,
  bodyStore: Record<string, Body>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [bodyId, body] of Object.entries(bodyStore)) {
    if (body.shape == null) continue
    const scope = new DisposeScope()
    try {
      const solid = table.get<OccShape>(body.shape)
      const { face_data, face_queries } = readShapeFaceMetadata(oc, scope, solid, {
        createdBy: body.created_by || '',
        bodyId: body.id,
        faceAncestry: body.face_ancestry ?? null,
        faceNames: body.face_names ?? null,
        profileQueries: body.profile_queries ?? [],
      })
      const mesh: TessMesh = {
        vertices: [],
        faces: [],
        face_data,
        triangle_to_face: [],
        face_queries,
        is_fallback: false,
      }
      const edgeResult = solidToEdges(oc, table, body.shape, {
        createdBy: body.created_by || '',
        bodyId: body.id,
        profileQueries: body.profile_queries ?? [],
        edgeAncestry: body.edge_ancestry ?? null,
        edgeNames: body.edge_names ?? null,
      })
      const vertexResult = solidToVertices(oc, table, body.shape, {
        createdBy: body.created_by || '',
        bodyId: body.id,
        profileQueries: body.profile_queries ?? [],
      })
      out[bodyId] = {
        mesh,
        edges: edgeResult.edges,
        edge_queries: edgeResult.edge_queries,
        vertices: vertexResult.vertices,
        vertex_queries: vertexResult.vertex_queries,
      }
    } catch {
      // Non-fatal: a body whose B-rep cannot be read just lacks ancestry, as in
      // the tessellation path.
    } finally {
      scope.dispose()
    }
  }
  return out
}

/**
 * Wire the builder dependencies for a given OCC module / scope / handle table.
 * Shared by ``solveLocally`` (persistent cross-solve table) and ``exportLocally``
 * (ephemeral table) so both build a document through the identical pipeline.
 */
function buildDeps(oc: OccModule, scope: DisposeScope, table: HandleTable): BuildDeps {
  return {
    trySolveFeature: createFeatureSolver(oc, scope, table),
    // Registers solved sketch plane/topology (_pt_/_topo_) so downstream
    // features resolve the profile; the builder handles brep ancestry
    // separately after tessellation.
    postRegister,
    // Seed builtin planes/origin so queries like `@builtin_plane_right`
    // (mirror plane resolution) resolve as repo elements, mirroring Python's
    // _init_global_repo.
    initGlobalRepo,
    tessellateBodies: (bodyStore, _repo) => tessellateBodies(oc, table, bodyStore),
    extractBrepMetadata: (bodyStore, _repo) => extractBrepMetadata(oc, table, bodyStore),
    brepDiffNewFaceHashes: (body) => brepDiffNewFaceHashes(oc, scope, body),
    brepDiffNewEdgeHashes: (body) => brepDiffNewEdgeHashes(oc, scope, body),
    brepDiffNewVertexHashes: (body) => brepDiffNewVertexHashes(oc, scope, body),
    // Cross-solve checkpoint cache: retain each checkpoint's shape so it
    // survives a downstream consume/free and into the next build; copy it on
    // restore so the rebuilt tail consumes an independent shape; evict a
    // discarded checkpoint's retained shapes by owner.
    retainCheckpointShape: (h, owner) => table.retain(h, owner),
    copyBodyShape: (h) => table.register(copyShape(oc, scope, table.get<OccShape>(h))),
    releaseCheckpoint: (fid) => table.releaseOwner('cp:' + fid),
  }
}

/**
 * Solve a document locally through the TS/WASM kernel.
 *
 * Returns the ``BuildResponse`` on success, or ``null`` when OCC.js is not
 * available (will return null).
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
  // Load OCC.js and the Rust sketch solver in parallel; both must be ready
  // before build() runs. initSketchSolver MUST be awaited: build() solves
  // sketches synchronously, so a fire-and-forget load races the first solve and
  // every sketch throws "Rust solver not initialised". A null result (wasm
  // absent) is fine — sketch features then throw and the builder catches them.
  const [oc] = await Promise.all([ensureOcc(), initSketchSolver()])
  if (!oc) {
    console.log('[solveLocally] OCC.js not available, returning null')
    return null
  }
  console.log('[solveLocally] OCC.js loaded, running build()')

  // A document switch invalidates every cached checkpoint handle: drop them
  // before solving the new doc so its handles do not pile up behind the old.
  const docId = typeof spec.id === 'string' ? spec.id : null
  if (docId !== lastDocId) {
    resetLocalSolveCache()
    lastDocId = docId
  }

  const scope = new DisposeScope()
  const table = (persistentTable ??= new HandleTable({ finalizerGuard: false }))
  // Caller override (tests) wins; otherwise feed the prior solve's state so the
  // builder restores the clean prefix and rebuilds only the dirty tail.
  const prevState = options.prevState !== undefined ? options.prevState : lastBuildState

  try {
    const deps = buildDeps(oc, scope, table)

    const specForBuild = options.validate
      ? { ...spec, _validate: true }
      : spec

    const response = build(specForBuild, {
      prevState,
      pickBoundary: options.pickBoundary ?? null,
      rollbackPosition: options.rollbackPosition ?? null,
    }, deps)
    // Remember the state (and the live handles it points at) for the next solve.
    lastBuildState = response._build_state
    return response
  } finally {
    // Only the transient scope is dropped. The HandleTable persists across
    // builds: build()'s per-checkpoint retain/releaseOwner manages its handles,
    // and the clean-prefix shapes must stay live for the next incremental solve.
    scope.dispose()
  }
}

// ─── local STEP/STL export ───

export interface LocalExportOptions {
  /** Output format. */
  format: 'step' | 'stl'
  /** Export this single body; omitted/null exports the whole assembly. */
  bodyId?: string | null
  /** STL only: linear deflection knob from the export dialog. STEP ignores it. */
  tessellation?: number
}

/**
 * Resolve the TopoDS shape to export from a completed build. With a ``bodyId``
 * it returns that body's solid; otherwise it returns the lone body's solid, or
 * a compound of every body's solid for a multi-body assembly. Mirrors the body
 * selection of the retired server-side export endpoints, but assembles a compound
 * (not a boolean fuse) so disjoint parts export cleanly.
 */
function resolveExportShape(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  state: BuildState,
  bodyId: string | null,
): OccShape | null {
  const order = state.feature_order
  if (!order.length) return null
  // Bodies accumulate across the feature stack, so the last feature's snapshot
  // is the final body set (deletions already removed). Its shape handles are
  // retained in `table` until disposeAll, so they are safe to dereference here.
  const lastCp = state.checkpoints[order[order.length - 1]]
  if (!lastCp) return null
  const bodies = lastCp.body_store_snapshot
  if (bodyId) {
    const body = bodies[bodyId]
    if (!body || body.shape == null) {
      throw new Error(`export: body '${bodyId}' not found`)
    }
    return table.get<OccShape>(body.shape)
  }
  const solids = Object.values(bodies).filter((b) => b.shape != null)
  if (solids.length === 0) return null
  if (solids.length === 1) return table.get<OccShape>(solids[0].shape!)
  const builder = scope.track(new oc.BRep_Builder())
  const compound = scope.track(new oc.TopoDS_Compound())
  builder.MakeCompound(compound)
  for (const body of solids) builder.Add(compound, table.get<OccShape>(body.shape!))
  return compound
}

/**
 * Build a document and serialise the result to STEP or STL bytes, entirely in
 * the WASM kernel (no backend round-trip). Returns ``null`` when OCC.js is
 * unavailable or the document produced no solid body.
 *
 * Runs a fresh full build on an ephemeral handle table so it never disturbs
 * ``solveLocally``'s persistent cross-solve cache.
 */
export async function exportLocally(
  spec: Record<string, unknown>,
  opts: LocalExportOptions,
): Promise<Uint8Array | null> {
  const [oc] = await Promise.all([ensureOcc(), initSketchSolver()])
  if (!oc) return null

  const scope = new DisposeScope()
  const table = new HandleTable({ finalizerGuard: false })
  try {
    const response = build(spec, { prevState: null }, buildDeps(oc, scope, table))
    const shape = resolveExportShape(oc, scope, table, response._build_state, opts.bodyId ?? null)
    if (!shape) return null
    if (opts.format === 'step') return stepShapeToBytes(oc, scope, shape)
    // STL deflection params mirror the old server export: linear = tess*2,
    // angular = tess*0.6. Default to the dialog's 0.5 if no value came through.
    const tess = opts.tessellation && opts.tessellation > 0 ? opts.tessellation : 0.5
    return shapeToStlBytes(oc, scope, shape, tess * 2, tess * 0.6)
  } finally {
    scope.dispose()
    table.disposeAll()
  }
}
