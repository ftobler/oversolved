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
import { ExportSelectionError, extractErrorMessage, isKernelTrap, KernelFault } from './errors'
import { initGlobalRepo } from './query'
import { createFeatureSolver } from './solverRegistry'
import { initSketchSolver, consumeSketchTrap, isSketchSolverReady, isSketchTopologyReady, resetSketchSolverAfterTrap } from './features/sketch'
import { postRegister } from './features/postRegister'
import { loadOccWeb, resetOccWeb } from './occ/loadOccWeb'
import { memoizedLoad } from './occ/memoizedLoad'
import { DisposeScope } from './occ/disposeScope'
import { HandleTable } from './occ/handleTable'
import { solidToMesh, solidToEdges, solidToVertices, solidFaceEdgeData, readShapeFaceMetadata } from './occ/tessellation'
import type { TessMesh } from './occ/tessellation'
import { timePhase } from './occ/phaseTimer'
import { readFaceFacts } from './occ/faceFacts'
import { WARM_UP_STEPS, type WarmUpState } from './occ/warmUp'
import { indexModifierDiffs, newIndexSets } from './occ/modifierAttribution'
import { copyShape, makeScaleTrsf, makeRigidTrsf, transformCopy } from './occ/transforms'
import { stepShapeToBytes, shapeToStlBytes } from './occ/stepIo'
import { splitStepSolids } from './occ/stepSplit'
import { resolveTessellation, type TessellationPreset } from './tessellationPresets'
import { measureParts, type Bbox6, type MeasureRecord } from './occ/measure'
import { surfaceAreaOf, volumeForMeasure } from './occ/volume'
import { shapeBbox } from './occ/faceBounds'
import { canonicalFaces, pickableEdgeCount } from './occ/partNames'
import { shapesIntersect } from './occ/booleans'
import { edgeLength, minDistance } from './occ/measureExtrema'
import { resolveMeasurePick } from './measurePick'
import { measureSelectionResolved } from '@/utils/measure/measureSelection'
import { OCC_CONFUSION } from './solverConstants'
import { MEASURE_STALE, MEASURE_UNRESOLVED, type MeasureOp, type MeasurePickRef, type MeasureAssemblyPick, type MeasureAssemblyPart } from './worker/solverProtocol'
import { MM_PER_LENGTH_UNIT, lengthUnitOf, partToAssemblyScale } from '@/utils/lengthUnit'
import type { OccHandle } from './occ/handleTable'
import type { OccModule, OccShape, OccTrsf } from './occ/occTypes'
import type { PartSolid, BuildState } from './types3d'
import type { PartResult, LengthUnit, Transform3D } from '../types/cad'
import type { Vec3 } from '@/utils/vec3'

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

// ─── solve generation ───
// The token a measurement request names, so the worker can refuse a request
// asked against geometry it no longer holds. A per-boot id because the whole
// cache dies with the Worker (a bare counter would repeat after a respawn),
// plus a counter that moves whenever `lastBuildState` is replaced or cleared.
const bootId = Math.floor(Math.random() * 0x7fffffff).toString(36)
let generationCount = 0
let generation = `${bootId}:0`

function bumpGeneration(): void {
  generationCount += 1
  generation = `${bootId}:${generationCount}`
}

/** The generation of the geometry the cache currently holds. */
export function currentGeneration(): string {
  return generation
}

// The body store a pick made during an open feature edit was made against: the
// pick-boundary checkpoint's snapshot, resolved here at solve time because this
// module is the one place that knows both the boundary and the build state.
let lastPickPartStore: Record<string, PartSolid> | null = null

// Reentrancy guard for the shared state above. `persistentTable`,
// `lastBuildState` and `lastDocId` are single-writer: a second solve entering
// while the first is between its awaits would swap the doc id (or reset the
// table) under a build that is still running, freeing the OCC handles the
// checkpoints point at. Production serializes solves in the WorkerActor, but
// that is out of this module's scope, so the invariant is enforced here rather
// than assumed.
let solveInFlight = false
// Set when the sketch module (solver + topology, one wasm package) trapped.
// The retry must then find a fresh module: a degraded build that reports a
// sketch "exception" would hide the dead kernel behind ok:true in the drive
// reply.
let sketchReloadRequired = false

/** Drop the cross-solve cache (handles + state). Called on doc switch. */
function resetLocalSolveCache(): void {
  const table = persistentTable
  persistentTable = null
  lastBuildState = null
  lastDocId = null
  lastPickPartStore = null
  // Whatever a measurement was asked against is gone with the cache.
  bumpGeneration()
  if (!table) return
  try {
    table.disposeAll()
  } catch (e) {
    // A delete that traps proves the heap was already undefined; recovery has
    // to drop every other handle without touching it again.
    if (isKernelTrap(e)) recoverTrap(e)
    throw e
  }
}

// Loader seam. Default is loadOccWeb (main-thread DOM loader); the Worker
// bootstrap installs the DOM-free loadOccWorker; tests inject the node
// MEMFS-backed module to drive the real production entry off-thread.
let occLoaderOverride: (() => Promise<OccModule | null>) | null = null
// The loader's own memo reset. `occCell.reset()` forgets the module this module
// holds, but every loader memoizes the instantiated module too, so without this
// the next load would hand back the same corrupt instance after a trap.
let occLoaderReset: (() => void) | null = null

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
 * worker loader; without it the main-thread loadOccWeb is used. `reset` drops
 * the loader's own module memo, which trap recovery needs to instantiate a
 * fresh module; without it the loader would replay the trapped one. Resetting
 * the cell drops whatever a previous loader had cached.
 */
export function setOccLoader(
  loader: (() => Promise<OccModule | null>) | null,
  reset: (() => void) | null = null,
): void {
  occLoaderOverride = loader
  occLoaderReset = reset
  occCell.reset()
}

/**
 * Discard everything that points into the trapped module. Deliberately does NOT
 * call `disposeAll()`: every handle's `.delete()` would run C++ on the corrupt
 * heap, which can trap again. The module is going away, so its allocations go
 * with it; dropping the references is the safe cleanup.
 *
 * Returns whether every module the trap killed has a live replacement. False
 * only for a sketch-package trap whose loader produced no module: the next
 * build would still find the dead instance, so the fault must not claim a
 * reload (and the MCP host drops the worker instead).
 */
function recoverLocalKernel(): boolean {
  // The sketch solver is a separate wasm instance with its own heap, so an OCC
  // trap cannot have damaged it; only discard it when the trap came out of it.
  // A byte-injected sketch module has no loader to re-run, so dropping it for
  // an OCC fault would degrade every later sketch.
  const sketchFault = consumeSketchTrap()
  persistentTable = null
  lastBuildState = null
  lastDocId = null
  lastPickPartStore = null
  // The trapped heap is gone, so nothing a measurement named survives.
  bumpGeneration()
  if (occLoaderReset) occLoaderReset()
  // The default main-thread loader memoizes its own module; an injected test
  // loader owns whatever cache it has, so only the default path is reset here.
  else if (occLoaderOverride === null) resetOccWeb()
  occCell.reset()
  if (!sketchFault) return true
  sketchReloadRequired = true
  return resetSketchSolverAfterTrap()
}

/** A trap that escaped the build is not a document verdict: recover, then
 *  report it as a typed fault so the drive boundary can surface a failed
 *  kernel rather than a feature error. */
function recoverTrap(e: unknown): never {
  const detail = extractErrorMessage(e)
  const reloaded = recoverLocalKernel()
  throw new KernelFault(detail, reloaded)
}

/**
 * Whether a sketch-package trap left the kernel without a replacement: the
 * reload latch is set and the module it needs is still missing.
 *
 * A headless worker asks this after every op. A `run` reports its kernel fault
 * as `solve.lastError` rather than as a thrown error (the reply must keep its
 * checkpoint and step outcomes), so an unrecovered fault would never reach the
 * host's error path; this is the state the host restarts the worker on.
 */
export function kernelReloadRequired(): boolean {
  return sketchReloadRequired && (!isSketchSolverReady() || !isSketchTopologyReady())
}

/** Run kernel cleanup, converting a disposal trap into the same reload path.
 *  Kept as a function so a trap can fail the solve from a finally block without
 *  a throw statement there (`no-unsafe-finally`). */
function cleanupKernel(cleanup: () => void): void {
  try {
    cleanup()
  } catch (e) {
    if (isKernelTrap(e)) recoverTrap(e)
    throw e
  }
}

/** @internal test-only: inject an OCC loader and reset all cached state. */
export function setSolveLocalsForTest(
  loader: (() => Promise<OccModule | null>) | null,
  reset: (() => void) | null = null,
): void {
  setOccLoader(loader, reset)
  resetLocalSolveCache()
  solveInFlight = false
  sketchReloadRequired = false
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
 * data. Used as ``BuildDeps.tessellateParts``.
 */
export function tessellateParts(
  oc: OccModule,
  table: HandleTable,
  partStore: Record<string, PartSolid>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [bodyId, body] of Object.entries(partStore)) {
    if (body.shape == null) continue
    try {
      const shape = body.shape
      // Read once for the two passes below that both sort the faces by them.
      const faceFacts = timePhase('render.faceFacts', () => readFaceFacts(oc, table.get(shape)))
      const mesh = timePhase('render.mesh', () => solidToMesh(oc, table, shape, {
        faceFacts,
        createdBy: body.created_by || '',
        partId: body.id,
        faceAncestry: body.face_ancestry ?? null,
        faceCapAncestry: body.face_cap_ancestry ?? null,
        faceUuids: body.face_uuids ?? null,
        faceOwner: body.face_owner ?? null,
        profileQueries: body.profile_queries ?? [],
        newElements: newIndexSets(body.brep_new, shape),
        modifiedBy: body.modified_by,
      }))
      const edgeResult = timePhase('render.edges', () => solidToEdges(oc, table, shape, {
        createdBy: body.created_by || '',
        partId: body.id,
        profileQueries: body.profile_queries ?? [],
        edgeAncestry: body.edge_ancestry ?? null,
        edgeUuids: body.edge_uuids ?? null,
        edgeOwner: body.edge_owner ?? null,
        newElements: newIndexSets(body.brep_new, shape),
        modifiedBy: body.modified_by,
        // The final render pass owns the class; the mesh-free metadata pass
        // below deliberately leaves it out.
        computeConvexity: true,
      }))
      const vertexResult = timePhase('render.vertices', () => solidToVertices(oc, table, shape, {
        createdBy: body.created_by || '',
        partId: body.id,
        profileQueries: body.profile_queries ?? [],
        faceUuids: body.face_uuids ?? null,
        edgeUuids: body.edge_uuids ?? null,
        newElements: newIndexSets(body.brep_new, shape),
        modifiedBy: body.modified_by,
      }))
      // One face-edge walk feeds both lists below (solidFaceEdgeData).
      const faceEdgeData = timePhase('render.faceEdges', () =>
        solidFaceEdgeData(oc, table, shape, edgeResult.edge_queries, faceFacts))
      // Per-face boundary edge queries: a face pick projects as a closed wire.
      mesh.face_edge_queries = faceEdgeData.face_edge_queries
      // The edges each face meets twice, so the selector can tell a seam from
      // an open shell's free edge (both are listed by one face only).
      mesh.face_seam_queries = faceEdgeData.face_seam_queries
      // The same walk, kept as sparse display indices: the viewport skips these
      // seams and the vertices that end no visible open edge. The arrays above
      // are untouched, so every name and query stays byte-identical.
      const hidden = faceEdgeData
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
        hidden_edges: hidden.hidden_edges,
        hidden_vertices: hidden.hidden_vertices,
        created_by: body.created_by ?? '',
        modified_by: body.modified_by ?? [],
      }
    } catch (e) {
      // A trap is not this body's problem: the module is unusable, so the whole
      // build must abort and reload rather than record a per-body log and go on
      // reading a corrupt heap.
      if (isKernelTrap(e)) throw e
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
 * ``tessellateParts`` (a ``mesh`` with empty geometry arrays but populated
 * ``face_data``/``face_queries``) so the builder's registration path is
 * identical whether it is handed metadata or a full mesh.
 */
export function extractBrepMetadata(
  oc: OccModule,
  table: HandleTable,
  partStore: Record<string, PartSolid>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [bodyId, body] of Object.entries(partStore)) {
    if (body.shape == null) continue
    const scope = new DisposeScope()
    try {
      const solid = table.get<OccShape>(body.shape)
      const shape = body.shape
      const { face_data, face_queries, face_uuids, face_created_by } = timePhase('meta.faces', () =>
        readShapeFaceMetadata(oc, scope, solid, {
          createdBy: body.created_by || '',
          partId: body.id,
          faceAncestry: body.face_ancestry ?? null,
          faceCapAncestry: body.face_cap_ancestry ?? null,
          faceUuids: body.face_uuids ?? null,
          faceOwner: body.face_owner ?? null,
          profileQueries: body.profile_queries ?? [],
          newElements: newIndexSets(body.brep_new, shape),
          modifiedBy: body.modified_by,
        }))
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
      const edgeResult = timePhase('meta.edges', () => solidToEdges(oc, table, shape, {
        createdBy: body.created_by || '',
        partId: body.id,
        profileQueries: body.profile_queries ?? [],
        edgeAncestry: body.edge_ancestry ?? null,
        edgeUuids: body.edge_uuids ?? null,
        edgeOwner: body.edge_owner ?? null,
        newElements: newIndexSets(body.brep_new, shape),
        modifiedBy: body.modified_by,
      }))
      const vertexResult = timePhase('meta.vertices', () => solidToVertices(oc, table, shape, {
        createdBy: body.created_by || '',
        partId: body.id,
        profileQueries: body.profile_queries ?? [],
        faceUuids: body.face_uuids ?? null,
        edgeUuids: body.edge_uuids ?? null,
        newElements: newIndexSets(body.brep_new, shape),
        modifiedBy: body.modified_by,
      }))
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
      if (isKernelTrap(e)) throw e
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
    tessellateParts: (partStore, _repo) => tessellateParts(oc, table, partStore),
    extractBrepMetadata: (partStore, _repo) => extractBrepMetadata(oc, table, partStore),
    indexModifierDiffs: (partStore) => indexModifierDiffs(oc, table, partStore),
    // Cross-solve checkpoint cache: retain each checkpoint's shape so it
    // survives a downstream consume/free and into the next build; copy it on
    // restore so the rebuilt tail consumes an independent shape (registered
    // under RESTORE_OWNER so the copy dies with its build); evict a discarded
    // checkpoint's retained shapes by owner. The eviction drops BOTH remaining
    // owners of the outgoing generation: the checkpoint retain, and the base
    // body registration -- which partSplit tags with the PRODUCING feature id,
    // covering shapes the fid created AND replacements it made while modifying
    // another feature's body. Without the second release every superseded
    // shape strands forever: the retain alone leaves rc>=1, and for a modifier
    // edit the leftover ref sits under a still-clean creator.
    retainCheckpointShape: (h, owner) => table.retain(h, owner),
    copyPartShape: (h, owner) => table.register(copyShape(oc, scope, table.get<OccShape>(h)), owner),
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
    try {
      return await solveLocallyGuarded(spec, options)
    } catch (e) {
      if (!(e instanceof KernelFault)) throw e
      // A trap is not a property of the document until it repeats. The first
      // one already discarded the module and cache, so this attempt starts from
      // a fresh instance and a full build (the caller's prevState pointed into
      // the dead cache and must not be reused).
      return await solveLocallyGuarded(spec, { ...options, prevState: null, bypassCache: false })
    }
  } finally {
    solveInFlight = false
  }
}

/** Load OCC and the Rust sketch modules for a build. A trap during the load is
 *  already a dead kernel; a sketch module that trapped earlier must be present,
 *  or the build would degrade into per-sketch feature exceptions. */
async function loadKernelForBuild(): Promise<OccModule | null> {
  let oc: OccModule | null
  let sketch: Awaited<ReturnType<typeof initSketchSolver>>
  try {
    const [loaded, sketchLoaded] = await Promise.all([ensureOcc(), initSketchSolver()])
    oc = loaded
    sketch = sketchLoaded
  } catch (e) {
    if (isKernelTrap(e)) recoverTrap(e)
    throw e
  }
  // A sketch-package trap cannot be recovered by building without the module:
  // that turns every sketch into a feature exception, which the drive reply
  // reads as ok. Keep the latch until a reload actually succeeds.
  if (sketchReloadRequired && (sketch === null || !isSketchTopologyReady())) {
    throw new KernelFault('the sketch solver could not be reloaded after a trap', false)
  }
  sketchReloadRequired = false
  return oc
}

/** The solve proper. Only ever called with the reentrancy guard held. */
async function solveLocallyGuarded(
  spec: Record<string, unknown>,
  options: SolveLocalOptions,
): Promise<BuildResponse | null> {
  // OCC and the Rust sketch solver must both be ready before build() runs;
  // loadKernelForBuild awaits both in parallel and enforces the post-trap
  // reload requirement. A null result (wasm absent) is fine: sketch features
  // then throw and the builder records them.
  const oc = await loadKernelForBuild()
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

  let faulted = false
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
    // The token moves with the state: the previous generation's geometry is now
    // a clean prefix of this build's, and only this state's snapshots are live.
    bumpGeneration()
    response.generation = generation
    lastPickPartStore = pickPartStoreOf(spec, response._build_state, options)
    return response
  } catch (e) {
    if (isKernelTrap(e)) {
      // The transient scope must not be disposed on the corrupt heap; recoverTrap
      // drops the module the allocations belong to.
      faulted = true
      recoverTrap(e)
    }
    throw e
  } finally {
    // Only the transient scope is dropped. The HandleTable persists across
    // builds: build()'s per-checkpoint retain/releaseOwner manages its handles,
    // and the clean-prefix shapes must stay live for the next incremental solve.
    if (!faulted) {
      cleanupKernel(() => {
        scope.dispose()
      })
    }
  }
}

// ─── local STEP/STL export ───

export interface LocalExportOptions {
  // Output format.
  format: 'step' | 'stl'
  // Export this single body; omitted/null exports the whole assembly. The drive
  // CLI and the worker share this spelling, so it stays the wire one.
  bodyId?: string | null
  // Export a chosen subset of bodies. A non-empty list takes precedence over
  // `bodyId`; the bodies are compounded so one file can hold all of them.
  bodyIds?: string[] | null
  // STL only: the mesh quality preset from the export dialog. STEP ignores it.
  tessellation?: TessellationPreset
}

/**
 * Resolve the TopoDS shape to export from a completed build. With a ``bodyId``
 * or a non-empty ``bodyIds`` it returns that body's solid / a compound of those
 * solids; otherwise it returns the lone body's solid, or a compound of every
 * body's solid for a multi-body assembly. A compound, not a boolean fuse, so
 * disjoint parts export cleanly.
 */
function resolveExportShape(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  state: BuildState,
  partId: string | null,
  partIds: readonly string[] | null,
): OccShape | null {
  const order = state.feature_order
  const chosen = partIds && partIds.length > 0
    ? [...new Set(partIds)]
    : partId ? [partId] : null
  const refuseMissing = (id: string, live: readonly string[]): never => {
    // Name the live ids in the refusal: the caller picked the id, so the
    // answer has to be the set it can pick from.
    throw new ExportSelectionError(
      `export: part '${id}' not found; live parts: ${live.join(', ') || 'none'}`,
    )
  }
  if (!order.length) {
    if (chosen) refuseMissing(chosen[0], [])
    return null
  }
  // Parts accumulate across the feature stack, so the last feature's snapshot
  // is the final body set (deletions already removed). Its shape handles are
  // retained in `table` until disposeAll, so they are safe to dereference here.
  const lastCp = state.checkpoints[order[order.length - 1]]
  if (!lastCp) {
    if (chosen) refuseMissing(chosen[0], [])
    return null
  }
  const parts = lastCp.body_store_snapshot
  if (chosen) {
    const live = Object.keys(parts).filter(id => parts[id].shape != null)
    const solids = chosen.map((id) => {
      const part = parts[id]
      if (!part || part.shape == null) return refuseMissing(id, live)
      return table.get<OccShape>(part.shape)
    })
    return compoundOf(oc, scope, solids)
  }
  const solids = Object.values(parts).filter((b) => b.shape != null)
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

/** The authored spec an export build takes (the solve payload plus its
 *  rollback position). Kept named so the inspect and bytes-only entries share
 *  one shape. */
type ExportSpec = Record<string, unknown>

/** What an export build left behind: the bytes and the build they came from.
 *  The response is what lets a reply report the features the file was made
 *  from, so a partial or failed feature is visible beside the file. */
export interface LocalExportOutcome {
  bytes: Uint8Array | null
  response: BuildResponse
}

/**
 * Build a document and serialise the result to STEP or STL bytes, entirely in
 * the WASM kernel (no backend round-trip). Returns ``null`` when OCC.js is
 * unavailable; the bytes are null when the document produced no solid body.
 *
 * Runs a fresh full build on an ephemeral handle table so it never disturbs
 * ``solveLocally``'s persistent cross-solve cache.
 */
export async function exportLocallyInspect(
  spec: ExportSpec,
  opts: LocalExportOptions,
  files?: ReadonlyMap<string, Uint8Array>,
): Promise<LocalExportOutcome | null> {
  const oc = await loadKernelForBuild()
  if (!oc) return null

  const scope = new DisposeScope()
  const table = new HandleTable()
  let faulted = false
  try {
    const response = build(spec, { prevState: null }, buildDeps(oc, scope, table, files))
    const shape = resolveExportShape(oc, scope, table, response._build_state, opts.bodyId ?? null, opts.bodyIds ?? null)
    const unitScale = MM_PER_LENGTH_UNIT[lengthUnitOf(spec.length_unit)]
    return { bytes: shape ? serialiseShape(oc, scope, shape, opts, unitScale) : null, response }
  } catch (e) {
    if (isKernelTrap(e)) {
      faulted = true
      recoverTrap(e)
    }
    throw e
  } finally {
    // A trapped module must not be touched again: both the scope and the table
    // would run delete() on the undefined heap.
    if (!faulted) {
      cleanupKernel(() => {
        scope.dispose()
        table.disposeAll()
      })
    }
  }
}

/** The bytes only, for callers that do not report the build. */
export async function exportLocally(
  spec: ExportSpec,
  opts: LocalExportOptions,
  files?: ReadonlyMap<string, Uint8Array>,
): Promise<Uint8Array | null> {
  const outcome = await exportLocallyInspect(spec, opts, files)
  return outcome?.bytes ?? null
}

// ─── local STEP split ───

/** One solid of a STEP file, written out as its own STEP bytes. */
export interface LocalStepSplit {
  solids: { bytes: Uint8Array; volume: number }[]
  leftovers: number
}

/**
 * Split one STEP file into one STEP file per solid, for the B2 import. A
 * deliberate single import, not a burst request: it loads OCC if it has not
 * been loaded yet and it never touches the cross-solve cache.
 *
 * Returns null when OCC.js is unavailable; the caller refuses the split import
 * rather than falling back to a mode the user did not pick.
 */
export async function splitStepLocally(bytes: Uint8Array, scale = 1.0): Promise<LocalStepSplit | null> {
  const oc = await ensureOcc()
  if (!oc) return null
  const scope = new DisposeScope()
  let faulted = false
  try {
    return splitStepSolids(oc, scope, bytes, scale)
  } catch (e) {
    if (isKernelTrap(e)) {
      faulted = true
      recoverTrap(e)
    }
    throw e
  } finally {
    if (!faulted) cleanupKernel(() => { scope.dispose() })
  }
}

/**
 * Run warm-up step `index` (occ/warmUp.ts) on the kernel. Never touches the
 * cross-solve cache or the persistent handle table. The Worker schedules it only
 * after the OCC preload produced a module, so this reads the memoized one rather
 * than starting a load. A trap recovers exactly as a split import's does, so the
 * next real solve meets a fresh module; any other failure is only logged, since
 * nothing waits on the warm-up. Returns whether a step ran.
 */
export async function warmUpLocally(index: number, state: WarmUpState): Promise<boolean> {
  const step = WARM_UP_STEPS[index]
  if (!step) return false
  const oc = await ensureOcc()
  if (!oc) return false
  try {
    step(oc, state)
  } catch (e) {
    if (isKernelTrap(e)) recoverTrap(e)
    console.warn(`[kernel] warm-up step ${index} failed; the first import runs cold`, e)
  }
  return true
}

// ─── local measure ───

export interface LocalBuildAndMeasure {
  response: BuildResponse
  measures: MeasureRecord
}

/**
 * The ids of the bodies the solve holds with a shape, from the last feature
 * checkpoint's body store: the same set `buildAndMeasureLocally` measures, so a
 * reply and a measure cannot name different live sets. The response's `bodies`
 * map is the render tessellation, which omits a body whose tessellation failed
 * while the solve still holds and measures it. Null when the response carries no
 * build state at all (no solve ran); an empty list is a solved document with no
 * bodies.
 */
export function finalLivePartIds(response: { _build_state?: unknown }): string[] | null {
  const state = response._build_state as BuildState | undefined
  if (state === undefined || state === null) return null
  const store = finalPartStoreOf(state) ?? {}
  return Object.entries(store)
    .filter(([, body]) => body.shape != null)
    .map(([id]) => id)
}

/** The final body set of a build: the last feature checkpoint's snapshot, the
 *  same one an export writes and a measure reports. */
function finalPartStoreOf(state: BuildState): Record<string, PartSolid> | null {
  const last = state.feature_order[state.feature_order.length - 1]
  if (last === undefined) return {}
  return state.checkpoints[last]?.body_store_snapshot ?? {}
}

/** The authored solve spec: the PartDoc plus the rollback fields, as
 *  `solveLocally` takes it. Named so the measurement entries below do not each
 *  spell a loose record (the feature-union ratchet counts those). */
type PartSolveSpec = Record<string, unknown>

/**
 * The body store a pick made during an open feature edit was made against: the
 * checkpoint of the feature before the edited one, exactly the one `build()`
 * tessellated for `pick_bodies`. Null when the solve carried no pick boundary
 * (no edit was open), which the measure reports as unresolved rather than
 * quietly measuring the final bodies.
 */
function pickPartStoreOf(
  spec: PartSolveSpec,
  state: BuildState,
  options: SolveLocalOptions,
): Record<string, PartSolid> | null {
  const boundary = options.pickBoundary
  if (boundary == null || boundary < 0) return null
  if (boundary === 0) return {}
  const features = spec.features
  const all: readonly { id?: unknown }[] = Array.isArray(features) ? features : []
  const rolled = options.rollbackPosition != null ? all.slice(0, options.rollbackPosition) : all
  const fid = String(rolled[boundary - 1]?.id ?? '')
  if (fid === '') return null
  return state.checkpoints[fid]?.body_store_snapshot ?? null
}

/** One answered measurement row for the headless MCP `measure between` call. */
export interface LocalPickMeasure {
  /** The readout kind the core named (`length`, `distance`, `angle`, `area`,
   *  `volume`) or the kernel op that answered it (`clearance`). */
  kind: string
  /** The label the HUD would print: `pitch`, `axial distance`, `center
   *  distance` and the rest of the one vocabulary; a kernel op states its own
   *  name. */
  label?: string
  value: number
  // Every secondary readout the row carries, mirroring the HUD's lines.
  extra?: { kind: string; value: number; label: string }[]
  points?: [Vec3, Vec3]
  note?: 'overlapping' | 'touching'
}

/**
 * Build a document once and answer a pick or a pick pair against the build,
 * through the same pure core the viewport uses. The analytic cells are answered
 * by the pair table with no OCC read at all; a cell the table marks `kernel` is
 * answered from the same build's bodies, exactly as the Worker answers a
 * viewport pick.
 *
 * The build is ephemeral (its own handle table), so nothing here disturbs the
 * live cross-solve cache. `null` when OCC is unavailable; a pick that does not
 * resolve throws, because an MCP caller asked for one specific measurement.
 */
export async function measurePicksLocally(
  spec: PartSolveSpec,
  picks: readonly string[],
  opts: { unit?: LengthUnit; files?: ReadonlyMap<string, Uint8Array> } = {},
): Promise<LocalPickMeasure | null> {
  const oc = await loadKernelForBuild()
  if (!oc) return null

  const scope = new DisposeScope()
  const table = new HandleTable()
  let faulted = false
  try {
    const response = build(spec, { prevState: null }, buildDeps(oc, scope, table, opts.files))
    const parts = response.bodies as Record<string, PartResult>
    const { readout, ask } = measureSelectionResolved(new Set(picks), { parts: parts, unit: opts.unit })
    if (readout !== null) {
      const extra = (readout.extra ?? []).map((row) => ({ kind: row.kind, value: row.value, label: row.label }))
      return {
        kind: readout.kind,
        label: readout.label,
        value: readout.value,
        ...(extra.length > 0 && { extra }),
      }
    }
    if (ask === null) throw new Error('measure: the pick or pick pair states no measurement')
    const store = finalPartStoreOf(response._build_state) ?? {}
    const answered = measurePicksOnStore(oc, table, store, ask.op, ask.picks)
    if (!answered.ok) throw new Error(`measure: ${answered.error}`)
    return {
      kind: ask.op,
      label: ask.op,
      value: answered.value,
      ...(answered.extra !== undefined && { extra: answered.extra }),
      ...(answered.points !== undefined && { points: answered.points }),
      ...(answered.note !== undefined && { note: answered.note }),
    }
  } catch (e) {
    if (isKernelTrap(e)) {
      faulted = true
      recoverTrap(e)
    }
    throw e
  } finally {
    if (!faulted) {
      cleanupKernel(() => {
        scope.dispose()
        table.disposeAll()
      })
    }
  }
}

// ─── kernel measurement against the live cache ───

/** A measurement the Worker answers from the solve it still holds: never a
 *  build, never a document write. */
export interface MeasureQuery {
  // The solve generation the picks were made on. A mismatch is refused.
  generation: string
  // The final bodies, or the pick-boundary checkpoint an edit renders.
  set: 'final' | 'pick'
  op: MeasureOp
  picks: MeasurePickRef[]
}

export type MeasureQueryResult =
  | {
    ok: true
    value: number
    // A body volume's surface area, the one secondary a kernel cell states.
    extra?: { kind: 'area'; value: number; label: string }[]
    points?: [Vec3, Vec3]
    // A clearance reads 0 for these; a plain distance states neither.
    note?: 'overlapping' | 'touching'
  }
  | { ok: false; error: string }

/**
 * Answer a measurement from the geometry the cross-solve cache holds, or refuse
 * by name. The request names its generation, so a reply can never describe
 * geometry the pick was not made against; a body or an element index that does
 * not resolve in the named set is refused rather than measured off a neighbour.
 *
 * Read-only: the proxies live in a local DisposeScope, and no handle the build
 * owns is touched. A trap recovers the module the same way the solve path does.
 */
export async function measureGeneration(query: MeasureQuery): Promise<MeasureQueryResult> {
  // Checked before the cache: a stale request must not read a live handle that
  // belongs to a newer generation.
  if (query.generation !== generation) return { ok: false, error: MEASURE_STALE }
  const oc = await ensureOcc()
  // The await yields, so the generation is re-read rather than assumed: it is
  // the token that makes a reply trustworthy, not a lock.
  if (query.generation !== generation) return { ok: false, error: MEASURE_STALE }
  const store = query.set === 'pick' ? lastPickPartStore : (lastBuildState === null ? null : finalPartStoreOf(lastBuildState))
  if (store === null) return { ok: false, error: MEASURE_UNRESOLVED }
  const table = persistentTable
  if (!table || !oc) return { ok: false, error: MEASURE_UNRESOLVED }
  return measurePicksOnStore(oc, table, store, query.op, query.picks)
}

/**
 * Run one measurement op over picks named in a body store. The caller owns the
 * table and the store: the live path hands over the cross-solve cache, and the
 * headless MCP path hands over the build it just made.
 */
function measurePicksOnStore(
  oc: OccModule,
  table: HandleTable,
  store: Record<string, PartSolid>,
  op: MeasureOp,
  picks: readonly MeasurePickRef[],
): MeasureQueryResult {
  const scope = new DisposeScope()
  let faulted = false
  try {
    const shapes: OccShape[] = []
    for (const pick of picks) {
      const shape = resolveMeasurePick(oc, scope, table, store, pick)
      if (!shape) return { ok: false, error: MEASURE_UNRESOLVED }
      shapes.push(shape)
    }
    return answerMeasureShapes(oc, scope, shapes, op)
  } catch (e) {
    if (isKernelTrap(e)) {
      faulted = true
      recoverTrap(e)
    }
    // A read that cannot run is not a measurement: state nothing.
    return { ok: false, error: MEASURE_UNRESOLVED }
  } finally {
    if (!faulted) cleanupKernel(() => { scope.dispose() })
  }
}

/**
 * Answer one measurement from shapes the caller has already resolved and
 * placed. Shared by the part path (a body store the solve holds) and the
 * assembly path (a part rebuilt and placed per request), so an op means the same
 * thing in both editors. Throws on a kernel trap; the caller owns the scope and
 * the recovery.
 */
function answerMeasureShapes(
  oc: OccModule,
  scope: DisposeScope,
  shapes: OccShape[],
  op: MeasureOp,
): MeasureQueryResult {
  if (op === 'length') {
    if (shapes.length !== 1) return { ok: false, error: MEASURE_UNRESOLVED }
    return { ok: true, value: edgeLength(oc, shapes[0]) }
  }
  if (op === 'area') {
    if (shapes.length !== 1) return { ok: false, error: MEASURE_UNRESOLVED }
    return { ok: true, value: surfaceAreaOf(oc, scope, shapes[0]) }
  }
  if (op === 'volume') {
    if (shapes.length !== 1) return { ok: false, error: MEASURE_UNRESOLVED }
    return {
      ok: true,
      value: volumeForMeasure(oc, scope, shapes[0]),
      // The body's own surface area is the one extra Möbius shows for a whole
      // part beside its volume, and it costs one more GProp pass on a shape
      // the caller already asked about.
      extra: [{ kind: 'area', value: surfaceAreaOf(oc, scope, shapes[0]), label: 'area' }],
    }
  }
  if (shapes.length !== 2) return { ok: false, error: MEASURE_UNRESOLVED }
  const read = minDistance(oc, shapes[0], shapes[1])
  if (read === null) return { ok: false, error: MEASURE_UNRESOLVED }
  if (op === 'clearance') {
    // DistShapeShape measures boundaries, and a body wholly inside another
    // reads a positive gap. The overlap probe is what makes a clearance 0
    // mean "they meet" rather than "their boundaries nearly miss".
    if (shapesIntersect(oc, shapes[0], shapes[1])) {
      return { ok: true, value: 0, points: [read.p1, read.p2], note: 'overlapping' }
    }
    if (read.value <= OCC_CONFUSION) {
      return { ok: true, value: 0, points: [read.p1, read.p2], note: 'touching' }
    }
  }
  return { ok: true, value: read.value, points: [read.p1, read.p2] }
}

/**
 * Build a document once and return both the solve response and the final body
 * set's measures. The body set is the last feature checkpoint's snapshot,
 * exactly the one `resolveExportShape` reads, so the measurement describes what
 * an export would contain. One build, not two: the regression corpus needs the
 * per-feature statuses from the response and the measures from the same bodies.
 *
 * The build runs on an ephemeral handle table, so the response's shape handles
 * are dead once this returns; its plain data (result, tessellated bodies) stays
 * valid. Callers that need live shapes (the oracle's STEP round trip) use the
 * persistent path in `src/oracle/run.ts` instead.
 */
export async function buildAndMeasureLocally(
  spec: Record<string, unknown>,
  files?: ReadonlyMap<string, Uint8Array>,
): Promise<LocalBuildAndMeasure | null> {
  const oc = await loadKernelForBuild()
  if (!oc) return null

  const scope = new DisposeScope()
  const table = new HandleTable()
  let faulted = false
  try {
    const response = build(spec, { prevState: null }, buildDeps(oc, scope, table, files))
    const order = response._build_state.feature_order
    const lastCp = order.length > 0 ? response._build_state.checkpoints[order[order.length - 1]] : undefined
    const parts = lastCp?.body_store_snapshot ?? {}
    // Keep ids parallel to shapes so the record can carry one entry per body;
    // the map iteration order is the body set's own order.
    const shapes: OccShape[] = []
    const partIds: string[] = []
    for (const [id, body] of Object.entries(parts)) {
      if (body.shape == null) continue
      partIds.push(id)
      shapes.push(table.get<OccShape>(body.shape))
    }
    return { response, measures: measureParts(oc, scope, shapes, partIds) }
  } catch (e) {
    if (isKernelTrap(e)) {
      faulted = true
      recoverTrap(e)
    }
    throw e
  } finally {
    if (!faulted) {
      cleanupKernel(() => {
        scope.dispose()
        table.disposeAll()
      })
    }
  }
}

/** One live body's own measure at a feature checkpoint. */
export interface FeatureMeasurePart {
  volume: number
  // The canonical face count and the pickable edge count `measure` reports.
  // A fillet that adds and removes the same volume still moves these, so the
  // delta row can see a shape change the volume cannot.
  faces: number
  edges: number
}

/** The volume and bbox a feature checkpoint's body set carried. */
export interface FeatureMeasure {
  id: string
  volume: number
  bbox: Bbox6 | null
  // Each live body's own measure at this checkpoint, so a delta row can name
  // the body a feature changed beside the all-bodies total.
  parts?: Record<string, FeatureMeasurePart>
}

function unionBbox(a: Bbox6 | null, b: Bbox6): Bbox6 {
  if (a === null) return [...b] as Bbox6
  return [
    Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]),
    Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5]),
  ]
}

// One measurement per unique shape, not per checkpoint: a checkpoint body set
// mostly shares handles with its neighbours, so sketches and untouched bodies
// cost nothing after the feature that minted them. The topology counts are part
// of the measure because a shape change can leave the volume and bbox alone
// (a fillet over a bend moves material both ways).
function measureFeatureCheckpoints(
  oc: OccModule,
  state: BuildState,
  table: HandleTable,
): FeatureMeasure[] {
  const scope = new DisposeScope()
  const cache = new Map<OccHandle, FeatureMeasurePart & { bbox: Bbox6 }>()
  let faulted = false
  try {
    const out: FeatureMeasure[] = []
    for (const id of state.feature_order) {
      const checkpoint = state.checkpoints[id]
      if (!checkpoint) continue
      let volume = 0
      let bbox: Bbox6 | null = null
      const parts: Record<string, FeatureMeasurePart> = {}
      for (const [bodyId, body] of Object.entries(checkpoint.body_store_snapshot)) {
        if (body.shape == null) continue
        let measured = cache.get(body.shape)
        if (measured === undefined) {
          const shape = table.get<OccShape>(body.shape)
          measured = {
            volume: volumeForMeasure(oc, scope, shape),
            bbox: shapeBbox(oc, scope, shape),
            faces: canonicalFaces(oc, scope, shape).length,
            edges: pickableEdgeCount(oc, scope, shape),
          }
          cache.set(body.shape, measured)
        }
        volume += measured.volume
        bbox = unionBbox(bbox, measured.bbox)
        parts[bodyId] = { volume: measured.volume, faces: measured.faces, edges: measured.edges }
      }
      out.push({ id, volume, bbox, parts })
    }
    return out
  } catch (e) {
    if (isKernelTrap(e)) faulted = true
    throw e
  } finally {
    if (!faulted) {
      cleanupKernel(() => {
        scope.dispose()
      })
    }
  }
}

/**
 * Per-feature volume and bbox of the last `solveLocally` build, or null when
 * the kernel is absent or the response is not the current cached build. The
 * checkpoint snapshots are still live in the persistent handle table, so this
 * reads the geometry the solve actually built without a second build.
 */
export async function measureSolveFeatures(response: BuildResponse): Promise<FeatureMeasure[] | null> {
  const state = response._build_state as BuildState | undefined
  if (!state || !Array.isArray(state.feature_order) || lastBuildState !== state || !persistentTable) return null
  const oc = await ensureOcc()
  if (!oc) return null
  try {
    return measureFeatureCheckpoints(oc, state, persistentTable)
  } catch (e) {
    // A cleanup trap is already a KernelFault carrying the reload; let it out
    // instead of turning it into "no deltas".
    if (e instanceof KernelFault) throw e
    if (isKernelTrap(e)) recoverTrap(e)
    // A missing handle here means the measurement cannot be trusted; an absent
    // delta list is honest, a partial or invented one would not be.
    return null
  }
}

/**
 * Build a document and report its final bodies' measures. Returns null when
 * OCC.js is unavailable.
 */
export async function measureLocally(
  spec: Record<string, unknown>,
  files?: ReadonlyMap<string, Uint8Array>,
): Promise<MeasureRecord | null> {
  const built = await buildAndMeasureLocally(spec, files)
  return built === null ? null : built.measures
}

// ─── assembly export ───

/** One part instance to export: its PartDoc spec and its solved world placement. */
export interface AssemblyExportPart {
  spec: Record<string, unknown>
  transform: Transform3D
}

/** One placed body: the instance handle it belongs to and its world shape. */
export interface AssemblyPlacedPart {
  handle: string
  partId: string
  shape: OccShape
}

// A test-only count of how many part specs placeAssemblyParts actually built.
// R3's dedupe assertion reads it: two instances of one doc must build once.
let assemblyBuildCount = 0

/** @internal test-only: how many builds the assembly placement path ran. */
export function assemblyBuildCountForTest(): number {
  return assemblyBuildCount
}

/** @internal test-only: reset the placement build counter. */
export function resetAssemblyBuildCountForTest(): void {
  assemblyBuildCount = 0
}

/**
 * Build every distinct part doc once, then place a transformed copy per
 * instance. One shared handle table owns both the source B-reps and the copies,
 * because `BRepBuilderAPI_Transform` hands back a shape that still shares its
 * source TShape (the reason `copyShape` exists): freeing a per-part table would
 * pull the geometry out from under the compound.
 *
 * The dedupe is keyed on `spec.id`, which the drive's partSolvePayload stamps
 * with the part's doc_id. A spec without an id is built per instance.
 */
function placeAssemblyParts(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  instances: readonly { handle: string; spec: Record<string, unknown>; transform: Transform3D }[],
  files?: ReadonlyMap<string, Uint8Array>,
): AssemblyPlacedPart[] {
  const built = new Map<string, { partId: string; shape: OccShape }[]>()
  const placed: AssemblyPlacedPart[] = []
  for (const instance of instances) {
    const key = typeof instance.spec.id === 'string' ? instance.spec.id : null
    let parts = key === null ? undefined : built.get(key)
    if (!parts) {
      assemblyBuildCount++
      const response = build(instance.spec, { prevState: null }, buildDeps(oc, scope, table, files))
      const order = response._build_state.feature_order
      const lastCp = order.length > 0 ? response._build_state.checkpoints[order[order.length - 1]] : undefined
      parts = []
      for (const [bodyId, body] of Object.entries(lastCp?.body_store_snapshot ?? {})) {
        if (body.shape == null) continue
        parts.push({ partId: bodyId, shape: table.get<OccShape>(body.shape) })
      }
      if (key !== null) built.set(key, parts)
    }
    // The assembly frame is millimetres, so an inch part's B-rep is scaled to
    // millimetres before the rigid placement. The scale is the right factor,
    // so it acts on the local point first (see makeRigidTrsf's multiply order).
    const placement = makeRigidTrsf(oc, scope, instance.transform)
    const unitScale = partToAssemblyScale(instance.spec)
    if (unitScale !== 1) placement.Multiply(makeScaleTrsf(oc, scope, [0, 0, 0], unitScale))
    for (const part of parts) {
      placed.push({
        handle: instance.handle,
        partId: part.partId,
        shape: scope.track(transformCopy(oc, scope, part.shape, placement)),
      })
    }
  }
  return placed
}

/** One part instance to measure: its spec, its solved placement and the handle
 *  the per-body ids are prefixed with. */
export interface AssemblyMeasurePart extends AssemblyExportPart {
  handle: string
}

/**
 * Measure an assembly's placed bodies. Each distinct part doc is built once and
 * copied per instance, and the per-body ids are `<handle>/<bodyId>` so a
 * compare against a CadQuery assembly can name the instance.
 */
export async function measureAssemblyLocally(
  parts: readonly AssemblyMeasurePart[],
  files?: ReadonlyMap<string, Uint8Array>,
): Promise<MeasureRecord | null> {
  const oc = await loadKernelForBuild()
  if (!oc) return null

  const scope = new DisposeScope()
  const table = new HandleTable()
  let faulted = false
  try {
    const placed = placeAssemblyParts(oc, scope, table, parts, files)
    if (placed.length === 0) return null
    return measureParts(
      oc,
      scope,
      placed.map(part => part.shape),
      placed.map(part => `${part.handle}/${part.partId}`),
    )
  } catch (e) {
    if (isKernelTrap(e)) {
      faulted = true
      recoverTrap(e)
    }
    throw e
  } finally {
    if (!faulted) {
      cleanupKernel(() => {
        scope.dispose()
        table.disposeAll()
      })
    }
  }
}

/**
 * Answer one assembly measurement by rebuilding each named part and placing it
 * at its solved pose. The anchor solver holds meshes only, so a kernel cell
 * (a spline length, a freeform area, an instance clearance) has no B-rep to
 * measure there; this is the same rebuild the assembly export pays, narrowed to
 * one readout.
 *
 * A pick names an element by the index in the SOLVE's render arrays, exactly as
 * a part pick does, so the resolver is the shared `resolveMeasurePick`. The
 * bundle and this build come from the same deterministic spec, which is what
 * makes the index mean the same body and element in both.
 */
export async function measureAssemblyPicksLocally(
  parts: readonly MeasureAssemblyPart[],
  op: MeasureOp,
  picks: readonly MeasureAssemblyPick[],
  files?: ReadonlyMap<string, Uint8Array>,
): Promise<MeasureQueryResult> {
  const oc = await loadKernelForBuild()
  if (!oc) return { ok: false, error: MEASURE_UNRESOLVED }

  const scope = new DisposeScope()
  const table = new HandleTable()
  let faulted = false
  try {
    const instances = buildPlacedAssemblyParts(oc, scope, table, parts, files)
    const shapes: OccShape[] = []
    for (const pick of picks) {
      const instance = instances.get(pick.handle)
      if (!instance) return { ok: false, error: MEASURE_UNRESOLVED }
      const picked = instancePickShapes(oc, scope, table, instance, pick)
      if (picked === null || picked.length === 0) return { ok: false, error: MEASURE_UNRESOLVED }
      // A whole instance with several bodies is one compound, so a volume or a
      // clearance answers for the instance, not for whichever body came first.
      const shape = picked.length === 1 ? picked[0] : compoundOf(oc, scope, picked)
      if (!shape) return { ok: false, error: MEASURE_UNRESOLVED }
      shapes.push(shape)
    }
    return answerMeasureShapes(oc, scope, shapes, op)
  } catch (e) {
    if (isKernelTrap(e)) {
      faulted = true
      recoverTrap(e)
    }
    return { ok: false, error: MEASURE_UNRESOLVED }
  } finally {
    if (!faulted) cleanupKernel(() => {
      scope.dispose()
      table.disposeAll()
    })
  }
}

/** One built shape of an instance: its id and the local solid the pick resolves in. */
interface PlacedSolid {
  bodyId: string
  solid: PartSolid
}

/** One instance's solids in solve order, plus the placement that puts them in assembly space. */
interface PlacedInstance {
  solids: PlacedSolid[]
  placement: OccTrsf
}

/**
 * Build every distinct part doc once (deduped on `spec.id`, the same key the
 * export path uses) and give every instance its own placement transform. The
 * list keeps the build's own order, including an entry with no shape, because
 * `partIndex` in an assembly entity key is a position in that order.
 */
function buildPlacedAssemblyParts(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  parts: readonly MeasureAssemblyPart[],
  files?: ReadonlyMap<string, Uint8Array>,
): Map<string, PlacedInstance> {
  const built = new Map<string, PlacedSolid[]>()
  const instances = new Map<string, PlacedInstance>()
  for (const part of parts) {
    const key = typeof part.spec.id === 'string' ? part.spec.id : null
    let solids = key === null ? undefined : built.get(key)
    if (!solids) {
      const response = build(part.spec, { prevState: null }, buildDeps(oc, scope, table, files))
      const store = finalPartStoreOf(response._build_state) ?? {}
      solids = Object.entries(store).map(([bodyId, solid]) => ({ bodyId, solid }))
      if (key !== null) built.set(key, solids)
    }
    // The assembly frame is millimetres: an inch part is scaled before the rigid
    // placement, the same order `placeAssemblyParts` uses.
    const placement = makeRigidTrsf(oc, scope, part.transform)
    const unitScale = partToAssemblyScale(part.spec)
    if (unitScale !== 1) placement.Multiply(makeScaleTrsf(oc, scope, [0, 0, 0], unitScale))
    instances.set(part.handle, { solids, placement })
  }
  return instances
}

/**
 * The world shapes one assembly pick names, or null when it does not resolve.
 * An element resolves in its solid's LOCAL frame and is placed afterwards; a
 * `body` pick returns every solid of the instance.
 */
function instancePickShapes(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  instance: PlacedInstance,
  pick: MeasureAssemblyPick,
): OccShape[] | null {
  const placed = (shape: OccShape): OccShape =>
    scope.track(transformCopy(oc, scope, shape, instance.placement))

  if (pick.kind === 'body') {
    const shapes: OccShape[] = []
    for (const entry of instance.solids) {
      if (entry.solid.shape == null) continue
      const shape = resolveMeasurePick(oc, scope, table, { [entry.bodyId]: entry.solid }, {
        bodyId: entry.bodyId,
        kind: 'body',
      })
      if (shape) shapes.push(placed(shape))
    }
    return shapes
  }

  const entry = pick.partIndex === undefined ? undefined : instance.solids[pick.partIndex]
  if (!entry || entry.solid.shape == null || pick.index === undefined) return null
  const shape = resolveMeasurePick(oc, scope, table, { [entry.bodyId]: entry.solid }, {
    bodyId: entry.bodyId,
    kind: pick.kind,
    index: pick.index,
  })
  return shape ? [placed(shape)] : null
}

function serialiseShape(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  opts: Pick<LocalExportOptions, 'format' | 'tessellation'>,
  // Millimetres per stored unit. STEP and STL are written in millimetres, so an
  // inch document's 0.5 leaves the file as 12.7 rather than as a 0.5 mm feature.
  unitScale = 1,
): Uint8Array {
  const out = unitScale === 1
    ? shape
    : scope.track(transformCopy(oc, scope, shape, makeScaleTrsf(oc, scope, [0, 0, 0], unitScale)))
  if (opts.format === 'step') return stepShapeToBytes(oc, scope, out)
  // STL deflection params come from the shared preset table; `normal` resolves
  // to the pair the old slider default produced, so a default export is stable.
  const { linearDeflection, angularDeflection } = resolveTessellation(opts.tessellation)
  return shapeToStlBytes(oc, scope, out, linearDeflection, angularDeflection)
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
  const oc = await loadKernelForBuild()
  if (!oc) return null

  const scope = new DisposeScope()
  const table = new HandleTable()
  let faulted = false
  try {
    const placed = placeAssemblyParts(
      oc,
      scope,
      table,
      parts.map((part, index) => ({ handle: String(index), spec: part.spec, transform: part.transform })),
      files,
    )
    const compound = compoundOf(oc, scope, placed.map(part => part.shape))
    if (!compound) return null
    return serialiseShape(oc, scope, compound, opts)
  } catch (e) {
    if (isKernelTrap(e)) {
      faulted = true
      recoverTrap(e)
    }
    throw e
  } finally {
    if (!faulted) {
      cleanupKernel(() => {
        scope.dispose()
        table.disposeAll()
      })
    }
  }
}
