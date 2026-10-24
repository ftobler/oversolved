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
import { extractErrorMessage, isKernelTrap, KernelFault } from './errors'
import { initGlobalRepo } from './query'
import { createFeatureSolver } from './solverRegistry'
import { initSketchSolver, consumeSketchTrap, isSketchTopologyReady, resetSketchSolverAfterTrap } from './features/sketch'
import { postRegister } from './features/postRegister'
import { loadOccWeb, resetOccWeb } from './occ/loadOccWeb'
import { memoizedLoad } from './occ/memoizedLoad'
import { DisposeScope } from './occ/disposeScope'
import { HandleTable } from './occ/handleTable'
import { solidToMesh, solidToEdges, solidToVertices, solidToFaceEdgeQueries, readShapeFaceMetadata } from './occ/tessellation'
import type { TessMesh } from './occ/tessellation'
import { indexModifierDiffs, newIndexSets } from './occ/modifierAttribution'
import { copyShape, makeRigidTrsf, transformCopy } from './occ/transforms'
import { stepShapeToBytes, shapeToStlBytes } from './occ/stepIo'
import { resolveTessellation, type TessellationPreset } from './tessellationPresets'
import { measureBodies, type Bbox6, type MeasureRecord } from './occ/measure'
import { volumeOf } from './occ/volume'
import { shapeBbox } from './occ/faceBounds'
import type { OccHandle } from './occ/handleTable'
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
 */
function recoverLocalKernel(): void {
  // The sketch solver is a separate wasm instance with its own heap, so an OCC
  // trap cannot have damaged it; only discard it when the trap came out of it.
  // Headless hosts inject those bytes with no loader to re-run, so dropping
  // them for an OCC fault would degrade every later sketch.
  const sketchFault = consumeSketchTrap()
  persistentTable = null
  lastBuildState = null
  lastDocId = null
  if (occLoaderReset) occLoaderReset()
  // The default main-thread loader memoizes its own module; an injected test
  // loader owns whatever cache it has, so only the default path is reset here.
  else if (occLoaderOverride === null) resetOccWeb()
  occCell.reset()
  if (sketchFault) {
    sketchReloadRequired = true
    resetSketchSolverAfterTrap()
  }
}

/** A trap that escaped the build is not a document verdict: recover, then
 *  report it as a typed fault so the drive boundary can surface a failed
 *  kernel rather than a feature error. */
function recoverTrap(e: unknown): never {
  const detail = extractErrorMessage(e)
  recoverLocalKernel()
  throw new KernelFault(detail)
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
        faceCapAncestry: body.face_cap_ancestry ?? null,
        faceUuids: body.face_uuids ?? null,
        faceOwner: body.face_owner ?? null,
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
        edgeOwner: body.edge_owner ?? null,
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
        faceCapAncestry: body.face_cap_ancestry ?? null,
        faceUuids: body.face_uuids ?? null,
        faceOwner: body.face_owner ?? null,
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
        edgeOwner: body.edge_owner ?? null,
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
  // Export this single body; omitted/null exports the whole assembly.
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
  bodyId: string | null,
  bodyIds: readonly string[] | null,
): OccShape | null {
  const order = state.feature_order
  if (!order.length) return null
  // Bodies accumulate across the feature stack, so the last feature's snapshot
  // is the final body set (deletions already removed). Its shape handles are
  // retained in `table` until disposeAll, so they are safe to dereference here.
  const lastCp = state.checkpoints[order[order.length - 1]]
  if (!lastCp) return null
  const bodies = lastCp.body_store_snapshot
  const chosen = bodyIds && bodyIds.length > 0
    ? [...new Set(bodyIds)]
    : bodyId ? [bodyId] : null
  if (chosen) {
    const solids = chosen.map((id) => {
      const body = bodies[id]
      if (!body || body.shape == null) {
        throw new Error(`export: body '${id}' not found`)
      }
      return table.get<OccShape>(body.shape)
    })
    return compoundOf(oc, scope, solids)
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
  const oc = await loadKernelForBuild()
  if (!oc) return null

  const scope = new DisposeScope()
  const table = new HandleTable()
  let faulted = false
  try {
    const response = build(spec, { prevState: null }, buildDeps(oc, scope, table, files))
    const shape = resolveExportShape(oc, scope, table, response._build_state, opts.bodyId ?? null, opts.bodyIds ?? null)
    if (!shape) return null
    return serialiseShape(oc, scope, shape, opts)
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

// ─── local measure ───

export interface LocalBuildAndMeasure {
  response: BuildResponse
  measures: MeasureRecord
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
    const bodies = lastCp?.body_store_snapshot ?? {}
    // Keep ids parallel to shapes so the record can carry one entry per body;
    // the map iteration order is the body set's own order.
    const shapes: OccShape[] = []
    const bodyIds: string[] = []
    for (const [id, body] of Object.entries(bodies)) {
      if (body.shape == null) continue
      bodyIds.push(id)
      shapes.push(table.get<OccShape>(body.shape))
    }
    return { response, measures: measureBodies(oc, scope, shapes, bodyIds) }
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

/** The volume and bbox a feature checkpoint's body set carried. */
export interface FeatureMeasure {
  id: string
  volume: number
  bbox: Bbox6 | null
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
// cost nothing after the feature that minted them. Volume and bbox only: area
// and the topology counts are not part of the per-feature delta.
function measureFeatureCheckpoints(
  oc: OccModule,
  state: BuildState,
  table: HandleTable,
): FeatureMeasure[] {
  const scope = new DisposeScope()
  const cache = new Map<OccHandle, { volume: number; bbox: Bbox6 }>()
  let faulted = false
  try {
    const out: FeatureMeasure[] = []
    for (const id of state.feature_order) {
      const checkpoint = state.checkpoints[id]
      if (!checkpoint) continue
      let volume = 0
      let bbox: Bbox6 | null = null
      for (const body of Object.values(checkpoint.body_store_snapshot)) {
        if (body.shape == null) continue
        let measured = cache.get(body.shape)
        if (measured === undefined) {
          const shape = table.get<OccShape>(body.shape)
          measured = { volume: volumeOf(oc, scope, shape), bbox: shapeBbox(oc, scope, shape) }
          cache.set(body.shape, measured)
        }
        volume += measured.volume
        bbox = unionBbox(bbox, measured.bbox)
      }
      out.push({ id, volume, bbox })
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
  const oc = await loadKernelForBuild()
  if (!oc) return null

  const scope = new DisposeScope()
  const table = new HandleTable()
  let faulted = false
  try {
    const placed: OccShape[] = []
    for (const part of parts) {
      const response = build(part.spec, { prevState: null }, buildDeps(oc, scope, table, files))
      // A part with no solid (an empty doc, a sketch-only doc) contributes
      // nothing rather than failing the whole export.
      const shape = resolveExportShape(oc, scope, table, response._build_state, null, null)
      if (!shape) continue
      // `transformCopy` hands back a fresh shape nobody owns: the compound is
      // read (serialised) before `scope.dispose()`, so the scope is its owner.
      placed.push(scope.track(transformCopy(oc, scope, shape, makeRigidTrsf(oc, scope, part.transform))))
    }
    const compound = compoundOf(oc, scope, placed)
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
