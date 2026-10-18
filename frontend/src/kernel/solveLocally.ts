/**
 * Live TS kernel solve pipeline.
 *
 * ``solveLocally`` loads OCC.js lazily, wires the builder deps (feature solver
 * adapter, tessellation, repository), calls ``build()``, and returns a
 * ``BuildResponse`` compatible with the existing ``applySolveResult`` path.
 * When OCC.js is unavailable it returns ``null``.
 */

import { build, RESTORE_OWNER, type BuildDeps, type BuildResponse } from './builder'
import { isDevBuild } from './isDevBuild'
import { initGlobalRepo } from './query'
import { createFeatureSolver } from './solverRegistry'
import { initSketchSolver } from './features/sketch'
import { postRegister } from './features/postRegister'
import { loadOccWeb } from './occ/loadOccWeb'
import { memoizedLoad } from './occ/memoizedLoad'
import { DisposeScope } from './occ/disposeScope'
import { HandleTable } from './occ/handleTable'
import { solidToMesh, solidToEdges, solidToVertices, solidToFaceEdgeQueries, readShapeFaceMetadata, bodyFrame } from './occ/tessellation'
import type { TessMesh } from './occ/tessellation'
import { indexModifierDiffs, newIndexSets } from './occ/modifierAttribution'
import { copyShape, makeRigidTrsf, transformCopy } from './occ/transforms'
import { stepShapeToBytes, shapeToStlBytes } from './occ/stepIo'
import { resolveTessellation, type TessellationPreset } from './tessellationPresets'
import { surfaceAreaOf, volumeOf } from './occ/volume'
import { solidCentroid } from './occ/primitives'
import { canonicalEdges, canonicalFaces, canonicalVertices } from './occ/bodyNames'
import type { OccModule, OccShape } from './occ/occTypes'
import type { Body, BuildState } from './types3d'
import type { Transform3D } from '../types/cad'

// ─── cross-solve checkpoint cache ───
// The checkpoint cache is not a side table: it IS the OCC handles in this
// HandleTable plus the BuildState that points at them. The table must outlive a
// single solve so the clean-prefix bodies' OCC shapes survive into the next
// build() (mirroring the SharedHarness pattern proven by checkpointMeshReal.test).
// A fresh table per solve (the old behaviour) left every prior handle dangling,
// so findFirstDirty could never reuse a checkpoint and every edit rebuilt the
// whole stack. Keyed by doc id; switching documents discards the old table.
let persistentTable: HandleTable | null = null
let lastBuildState: BuildState | null = null
let lastDocId: string | null = null

// Reentrancy guard for the shared state above. `persistentTable`,
// `lastBuildState` and `lastDocId` are single-writer: a second solve entering
// while the first is between its awaits would swap the doc id (or reset the
// table) under a build that is still running, freeing the OCC handles the
// checkpoints point at. Production serializes solves in the WorkerActor, but
// that is out of this module's scope, so the invariant is enforced here rather
// than assumed.
let solveInFlight = false

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

// The OCC module cell, memoized per successful result. The null/rejection
// eviction matters here: the Worker preloads the kernel at spawn, so that one
// load is the only early attempt a session gets, and pinning a failure would
// read as "OCC unavailable" for the Worker's whole lifetime. The loaders below
// this cell already evict their own failed promises so the next call retries.
const occCell = memoizedLoad(async (): Promise<OccModule | null> => {
  const loader = occLoaderOverride ?? loadOccWeb
  return loader()
})

/**
 * Install the OCC loader. The Worker bootstrap calls this with the DOM-free
 * worker loader; without it the main-thread loadOccWeb is used. Resetting the
 * cell drops whatever a previous loader had cached.
 */
export function setOccLoader(loader: (() => Promise<OccModule | null>) | null): void {
  occLoaderOverride = loader
  occCell.reset()
}

/** @internal test-only: inject an OCC loader and reset all cached state. */
export function setSolveLocalsForTest(
  loader: (() => Promise<OccModule | null>) | null,
): void {
  setOccLoader(loader)
  resetLocalSolveCache()
  solveInFlight = false
}

/** @internal test-only: the persistent cross-solve HandleTable, so leak-gate
 *  tests can assert its live handle count stays bounded across solves. */
export function persistentTableForTest(): HandleTable | null {
  return persistentTable
}

/** Load (or return the already-loaded) OCC module; a failed load retries on the
 *  next call instead of pinning "unavailable". */
function ensureOcc(): Promise<OccModule | null> {
  return occCell.load()
}

/**
 * Start the OCC load without solving anything, so the first document open
 * finds the kernel already compiled. Shares ensureOcc's cell: a solve that
 * arrives mid-load awaits the same promise instead of starting a second one.
 */
export function preloadOcc(): Promise<OccModule | null> {
  return ensureOcc()
}

/**
 * Tessellate every body in the store and return per-body mesh/edge/vertex
 * data. Used as ``BuildDeps.tessellateBodies``.
 */
export function tessellateBodies(
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
        faceUuids: body.face_uuids ?? null,
        profileQueries: body.profile_queries ?? [],
        newElements: newIndexSets(body.brep_new, body.shape),
        modifiedBy: body.modified_by,
      })
      const edgeResult = solidToEdges(oc, table, body.shape, {
        createdBy: body.created_by || '',
        bodyId: body.id,
        profileQueries: body.profile_queries ?? [],
        edgeAncestry: body.edge_ancestry ?? null,
        edgeUuids: body.edge_uuids ?? null,
        newElements: newIndexSets(body.brep_new, body.shape),
        modifiedBy: body.modified_by,
      })
      const vertexResult = solidToVertices(oc, table, body.shape, {
        createdBy: body.created_by || '',
        bodyId: body.id,
        profileQueries: body.profile_queries ?? [],
        faceUuids: body.face_uuids ?? null,
        edgeUuids: body.edge_uuids ?? null,
        newElements: newIndexSets(body.brep_new, body.shape),
        modifiedBy: body.modified_by,
      })
      // Per-face boundary edge queries: a face pick projects as a closed wire.
      mesh.face_edge_queries = solidToFaceEdgeQueries(oc, table, body.shape, edgeResult.edge_queries)
      out[bodyId] = {
        mesh,
        edges: edgeResult.edges,
        edge_queries: edgeResult.edge_queries,
        edge_uuids: edgeResult.edge_uuids,
        edge_created_by: edgeResult.edge_created_by,
        vertices: vertexResult.vertices,
        vertex_queries: vertexResult.vertex_queries,
        vertex_uuids: vertexResult.vertex_uuids,
        vertex_created_by: vertexResult.vertex_created_by,
        created_by: body.created_by ?? '',
        modified_by: body.modified_by ?? [],
      }
    } catch (e) {
      // Non-fatal: a body that fails to tessellate still has valid topology, so
      // the rest of the document still solves. Reported in every build: dropping
      // the only body of a STEP import leaves a document that solved "ok" and
      // renders nothing, and this log is the sole way to tell that from an empty
      // file (that is exactly how the assembly-sized `bodyFrame` overflow hid).
      console.error(`[kernel] body ${bodyId} failed to tessellate; it will not render`, e)
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
      const { face_data, face_queries, face_uuids, face_created_by } = readShapeFaceMetadata(oc, scope, solid, {
        createdBy: body.created_by || '',
        bodyId: body.id,
        faceAncestry: body.face_ancestry ?? null,
        faceUuids: body.face_uuids ?? null,
        profileQueries: body.profile_queries ?? [],
        newElements: newIndexSets(body.brep_new, body.shape),
        modifiedBy: body.modified_by,
      })
      const mesh: TessMesh = {
        vertices: [],
        faces: [],
        face_data,
        triangle_to_face: [],
        face_queries,
        face_uuids,
        face_created_by,
        is_fallback: false,
      }
      const edgeResult = solidToEdges(oc, table, body.shape, {
        createdBy: body.created_by || '',
        bodyId: body.id,
        profileQueries: body.profile_queries ?? [],
        edgeAncestry: body.edge_ancestry ?? null,
        edgeUuids: body.edge_uuids ?? null,
        newElements: newIndexSets(body.brep_new, body.shape),
        modifiedBy: body.modified_by,
      })
      const vertexResult = solidToVertices(oc, table, body.shape, {
        createdBy: body.created_by || '',
        bodyId: body.id,
        profileQueries: body.profile_queries ?? [],
        faceUuids: body.face_uuids ?? null,
        edgeUuids: body.edge_uuids ?? null,
        newElements: newIndexSets(body.brep_new, body.shape),
        modifiedBy: body.modified_by,
      })
      out[bodyId] = {
        mesh,
        edges: edgeResult.edges,
        edge_queries: edgeResult.edge_queries,
        edge_uuids: edgeResult.edge_uuids,
        edge_created_by: edgeResult.edge_created_by,
        vertices: vertexResult.vertices,
        vertex_queries: vertexResult.vertex_queries,
        vertex_uuids: vertexResult.vertex_uuids,
        vertex_created_by: vertexResult.vertex_created_by,
        created_by: body.created_by ?? '',
        modified_by: body.modified_by ?? [],
      }
    } catch (e) {
      // Non-fatal: a body whose B-rep cannot be read just lacks ancestry, as in
      // the tessellation path -- and reported in every build for the same reason.
      console.error(`[kernel] body ${bodyId} failed B-rep identification; it loses its ancestry`, e)
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
function buildDeps(oc: OccModule, scope: DisposeScope, table: HandleTable, files?: ReadonlyMap<string, Uint8Array>): BuildDeps {
  return {
    trySolveFeature: createFeatureSolver(oc, scope, table, files),
    // Registers solved sketch plane/topology (_pt_/_topo_) so downstream
    // features resolve the profile; the builder handles brep ancestry
    // separately after tessellation.
    postRegister,
    // Seed builtin planes/origin so queries like `@builtin_plane_right`
    // (mirror plane resolution) resolve as repo elements.
    initGlobalRepo,
    tessellateBodies: (bodyStore, _repo) => tessellateBodies(oc, table, bodyStore),
    extractBrepMetadata: (bodyStore, _repo) => extractBrepMetadata(oc, table, bodyStore),
    indexModifierDiffs: (bodyStore) => indexModifierDiffs(oc, table, bodyStore),
    // Cross-solve checkpoint cache: retain each checkpoint's shape so it
    // survives a downstream consume/free and into the next build; copy it on
    // restore so the rebuilt tail consumes an independent shape (registered
    // under RESTORE_OWNER so the copy dies with its build); evict a discarded
    // checkpoint's retained shapes by owner. The eviction drops BOTH remaining
    // owners of the outgoing generation: the checkpoint retain, and the base
    // body registration -- which bodySplit tags with the PRODUCING feature id,
    // covering shapes the fid created AND replacements it made while modifying
    // another feature's body. Without the second release every superseded
    // shape strands forever: the retain alone leaves rc>=1, and for a modifier
    // edit the leftover ref sits under a still-clean creator.
    retainCheckpointShape: (h, owner) => table.retain(h, owner),
    copyBodyShape: (h, owner) => table.register(copyShape(oc, scope, table.get<OccShape>(h)), owner),
    releaseCheckpoint: (fid) => {
      table.releaseOwner('cp:' + fid)
      table.releaseOwner(fid)
    },
    releaseRestoreCopies: () => table.releaseOwner(RESTORE_OWNER),
    // The _validate comparison build gets throwaway wiring (the exportLocally
    // pattern): its BuildState is discarded the moment validation ends, so on
    // the persistent table every inner shape would strand under cp:<fid> /
    // <fid> owners no later eviction can name -- one full solid generation
    // per validated solve. A fresh scope + table, both disposed after,
    // contain that generation completely and cannot disturb outer accounting.
    isolatedValidationDeps: () => {
      const isoScope = new DisposeScope()
      const isoTable = new HandleTable()
      return {
        deps: buildDeps(oc, isoScope, isoTable, files),
        dispose: () => {
          isoScope.dispose()
          isoTable.disposeAll()
        },
      }
    },
  }
}

interface SolveLocalOptions {
  prevState?: BuildResponse['_build_state'] | null
  pickBoundary?: number | null
  rollbackPosition?: number | null
  validate?: boolean
  bypassCache?: boolean
  // Import file bytes by registry id, resolved on the main thread. Kept off the
  // wire options so runtime buffers never ride in a structured-cloneable option.
  files?: ReadonlyMap<string, Uint8Array>
}

/**
 * Solve a document locally through the TS/WASM kernel.
 *
 * Returns the ``BuildResponse`` on success, or ``null`` when OCC.js is not
 * available (will return null).
 *
 * Not reentrant: an overlapping call throws rather than interleave two builds
 * over the shared cross-solve cache.
 */
export async function solveLocally(
  spec: Record<string, unknown>,
  options: SolveLocalOptions = {},
): Promise<BuildResponse | null> {
  // Refuse rather than corrupt: the shared build state below has no locking, so
  // an overlapping solve is a caller bug (solves must be serialized) and a loud
  // rejection is recoverable, while a silently interleaved build is not.
  if (solveInFlight) {
    throw new Error(
      '[solveLocally] a solve is already in flight; the cross-solve checkpoint cache ' +
      'is single-writer, serialize solves (the WorkerActor does) instead of overlapping them',
    )
  }
  solveInFlight = true
  try {
    return await solveLocallyGuarded(spec, options)
  } finally {
    solveInFlight = false
  }
}

/** The solve proper. Only ever called with the reentrancy guard held. */
async function solveLocallyGuarded(
  spec: Record<string, unknown>,
  options: SolveLocalOptions,
): Promise<BuildResponse | null> {
  // Load OCC.js and the Rust sketch solver in parallel; both must be ready
  // before build() runs. initSketchSolver MUST be awaited: build() solves
  // sketches synchronously, so a fire-and-forget load races the first solve and
  // every sketch throws "Rust solver not initialised". A null result (wasm
  // absent) is fine, sketch features then throw and the builder catches them.
  const [oc] = await Promise.all([ensureOcc(), initSketchSolver()])
  if (!oc) {
    // Dev-only diagnostics: this runs on every solve in the hot path, so prod
    // builds stay silent (same gate as handleTable/loadOccWeb).
    if (isDevBuild()) console.log('[solveLocally] OCC.js not available, returning null')
    return null
  }

  // A document switch invalidates every cached checkpoint handle: drop them
  // before solving the new doc so its handles do not pile up behind the old.
  const docId = typeof spec.id === 'string' ? spec.id : null
  if (docId !== lastDocId) {
    resetLocalSolveCache()
    lastDocId = docId
  }

  const scope = new DisposeScope()
  const table = (persistentTable ??= new HandleTable())
  // Caller override (tests) wins; otherwise feed the prior solve's state so the
  // builder restores the clean prefix and rebuilds only the dirty tail.
  // When bypassCache is set the previous cache is ignored, the solve builds
  // every feature from scratch (used by the explicit re-solve button).
  const prevState = options.bypassCache
    ? null
    : (options.prevState !== undefined ? options.prevState : lastBuildState)

  try {
    const deps = buildDeps(oc, scope, table, options.files)

    // bypassCache discards the whole previous build, so the builder sees no
    // prevState and its eviction loop never runs: every checkpoint retain,
    // base body registration and restore copy of the outgoing generation would
    // strand in the persistent table. Release them here, where that cache
    // lives, through the same wiring a normal incremental build uses.
    if (options.bypassCache && lastBuildState) {
      for (const fid of lastBuildState.feature_order) deps.releaseCheckpoint?.(fid)
      deps.releaseRestoreCopies?.()
    }

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
  // Output format.
  format: 'step' | 'stl'
  // Export this single body; omitted/null exports the whole assembly.
  bodyId?: string | null
  // STL only: the mesh quality preset from the export dialog. STEP ignores it.
  tessellation?: TessellationPreset
}

/**
 * Resolve the TopoDS shape to export from a completed build. With a ``bodyId``
 * it returns that body's solid; otherwise it returns the lone body's solid, or
 * a compound of every body's solid for a multi-body assembly. A compound,
 * not a boolean fuse, so disjoint parts export cleanly.
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
  return compoundOf(oc, scope, solids.map((b) => table.get<OccShape>(b.shape!)))
}

/**
 * A compound of `shapes`, or the lone shape when there is only one. Disjoint
 * solids assemble (never boolean-fuse): overlapping parts of an assembly are a
 * modelling fact to export, not an error to resolve.
 */
function compoundOf(oc: OccModule, scope: DisposeScope, shapes: OccShape[]): OccShape | null {
  if (shapes.length === 0) return null
  if (shapes.length === 1) return shapes[0]
  const builder = scope.track(new oc.BRep_Builder())
  const compound = scope.track(new oc.TopoDS_Compound())
  builder.MakeCompound(compound)
  for (const shape of shapes) builder.Add(compound, shape)
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
  files?: ReadonlyMap<string, Uint8Array>,
): Promise<Uint8Array | null> {
  const [oc] = await Promise.all([ensureOcc(), initSketchSolver()])
  if (!oc) return null

  const scope = new DisposeScope()
  const table = new HandleTable()
  try {
    const response = build(spec, { prevState: null }, buildDeps(oc, scope, table, files))
    const shape = resolveExportShape(oc, scope, table, response._build_state, opts.bodyId ?? null)
    if (!shape) return null
    return serialiseShape(oc, scope, shape, opts)
  } finally {
    scope.dispose()
    table.disposeAll()
  }
}

// ─── local measure ───

export type MeasurePoint = [number, number, number]

/** What `measureLocally` reports for a document's final body set. */
export interface LocalMeasure {
  bodyCount: number
  // Summed BRepGProp volume over the closed bodies.
  volume: number
  // Summed surface area over the bodies, open shells included.
  area: number
  // Volume-weighted centre of mass over the bodies; null when there are none.
  centroid: MeasurePoint | null
  // Union of the bodies' edge-sampled AABBs (bodyFrame, the same box the
  // classifiers read); null when there are none.
  bbox: { min: MeasurePoint; max: MeasurePoint } | null
  faces: number
  edges: number
  vertices: number
}

/**
 * Build a document and report its final bodies' volume, area, centroid, AABB
 * and B-rep counts. The body set is the last feature checkpoint's snapshot,
 * exactly the one `resolveExportShape` reads, so the measurement describes
 * what an export would contain. Returns null when OCC.js is unavailable.
 */
export async function measureLocally(
  spec: Record<string, unknown>,
  files?: ReadonlyMap<string, Uint8Array>,
): Promise<LocalMeasure | null> {
  const [oc] = await Promise.all([ensureOcc(), initSketchSolver()])
  if (!oc) return null

  const scope = new DisposeScope()
  const table = new HandleTable()
  try {
    const response = build(spec, { prevState: null }, buildDeps(oc, scope, table, files))
    const order = response._build_state.feature_order
    const lastCp = order.length > 0 ? response._build_state.checkpoints[order[order.length - 1]] : undefined
    const bodies = lastCp?.body_store_snapshot ?? {}
    let volume = 0
    let area = 0
    let faces = 0
    let edges = 0
    let vertices = 0
    let bodyCount = 0
    let weight = 0
    const weightedCentroid: MeasurePoint = [0, 0, 0]
    const centroidSum: MeasurePoint = [0, 0, 0]
    const min: MeasurePoint = [Infinity, Infinity, Infinity]
    const max: MeasurePoint = [-Infinity, -Infinity, -Infinity]
    for (const body of Object.values(bodies)) {
      if (body.shape == null) continue
      const shape = table.get<OccShape>(body.shape)
      const bodyVolume = volumeOf(oc, scope, shape)
      volume += bodyVolume
      area += surfaceAreaOf(oc, scope, shape)
      const centroid = solidCentroid(oc, scope, shape)
      weight += bodyVolume
      for (let axis = 0; axis < 3; axis++) {
        weightedCentroid[axis] += centroid[axis] * bodyVolume
        centroidSum[axis] += centroid[axis]
      }
      // bodyFrame is edge-sampled (BRepBndLib is absent from the OCC build),
      // so a fully edgeless bulging surface is the one shape it can undersize,
      // the same tolerance the classifier frames carry.
      const frame = bodyFrame(oc, scope, shape)
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], frame.center[axis] - frame.half[axis])
        max[axis] = Math.max(max[axis], frame.center[axis] + frame.half[axis])
      }
      faces += canonicalFaces(oc, scope, shape).length
      edges += canonicalEdges(oc, scope, shape).length
      vertices += canonicalVertices(oc, scope, shape).length
      bodyCount += 1
    }
    // An open shell (onlyClosed VolumeProperties integrates to ~0) has no
    // volume to weight by, so its centroid is the plain body average.
    const centroid: MeasurePoint | null = bodyCount === 0
      ? null
      : Math.abs(weight) > 1e-12
        ? [weightedCentroid[0] / weight, weightedCentroid[1] / weight, weightedCentroid[2] / weight]
        : [centroidSum[0] / bodyCount, centroidSum[1] / bodyCount, centroidSum[2] / bodyCount]
    return {
      bodyCount,
      volume,
      area,
      centroid,
      bbox: bodyCount === 0 ? null : { min, max },
      faces,
      edges,
      vertices,
    }
  } finally {
    scope.dispose()
    table.disposeAll()
  }
}

// ─── assembly export ───

/** One part instance to export: its PartDoc spec and its solved world placement. */
export interface AssemblyExportPart {
  spec: Record<string, unknown>
  transform: Transform3D
}

function serialiseShape(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  opts: Pick<LocalExportOptions, 'format' | 'tessellation'>,
): Uint8Array {
  if (opts.format === 'step') return stepShapeToBytes(oc, scope, shape)
  // STL deflection params come from the shared preset table; `normal` resolves
  // to the pair the old slider default produced, so a default export is stable.
  const { linearDeflection, angularDeflection } = resolveTessellation(opts.tessellation)
  return shapeToStlBytes(oc, scope, shape, linearDeflection, angularDeflection)
}

/**
 * Build every part of an assembly, move it to its solved placement, and
 * serialise the union as one STEP/STL file. Returns ``null`` when OCC.js is
 * unavailable or no part produced a solid body.
 *
 * This is the heavy path: the anchor solver holds only meshes, so analytic
 * output has to rehydrate each part's B-rep by re-running its feature stack.
 * Exports are rare, so the cost is paid here rather than kept warm in a cache.
 * The mesh-only alternative (`utils/assemblyExport.ts`) needs no OCC at all.
 *
 * Every part shares one ``HandleTable``: a part placed at identity gets an
 * identity ``gp_Trsf``, and ``BRepBuilderAPI_Transform`` then hands back a shape
 * that still shares its source TShape (the reason ``copyShape`` exists). Freeing
 * a per-part table would pull that geometry out from under the compound.
 */
export async function exportAssemblyLocally(
  parts: AssemblyExportPart[],
  opts: LocalExportOptions,
  files?: ReadonlyMap<string, Uint8Array>,
): Promise<Uint8Array | null> {
  const [oc] = await Promise.all([ensureOcc(), initSketchSolver()])
  if (!oc) return null

  const scope = new DisposeScope()
  const table = new HandleTable()
  try {
    const placed: OccShape[] = []
    for (const part of parts) {
      const response = build(part.spec, { prevState: null }, buildDeps(oc, scope, table, files))
      // A part with no solid (an empty doc, a sketch-only doc) contributes
      // nothing rather than failing the whole export.
      const shape = resolveExportShape(oc, scope, table, response._build_state, null)
      if (!shape) continue
      // `transformCopy` hands back a fresh shape nobody owns: the compound is
      // read (serialised) before `scope.dispose()`, so the scope is its owner.
      placed.push(scope.track(transformCopy(oc, scope, shape, makeRigidTrsf(oc, scope, part.transform))))
    }
    const compound = compoundOf(oc, scope, placed)
    if (!compound) return null
    return serialiseShape(oc, scope, compound, opts)
  } finally {
    scope.dispose()
    table.disposeAll()
  }
}
