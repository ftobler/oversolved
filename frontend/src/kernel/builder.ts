// Orchestrates the feature-stack solve loop with dirty detection, checkpoint cache, and
// incremental rebuild. Feature solvers are injected via a registry, so this module stays
// testable with mock solvers.
//
// Ancestry registration, snapshot/restore and the hash/validation helpers live in
// sibling modules (builderAncestry.ts, builderSnapshot.ts, builderHash.ts); this file
// stays the orchestrator and re-exports the public surface those modules used to expose.

import { extractErrorMessage } from './errors'
import { clearConsumedBodyAncestry, setCurrentFeatureId } from './query'
import { BUILTIN_PLANE_RESULTS } from './solverConstants'
import type { Body, FeatureCheckpoint, BuildState } from './types3d'
import {
  type BuildDeps,
  type BuildOptions,
  type BuildResponse,
  type RebuildValidation,
} from './builderTypes'
import { stableJson, hashCheckpointSpec, hashResultDict, diffRepoSnapshot } from './builderHash'
import {
  RESTORE_OWNER,
  snapshotRepo,
  repoFromSnapshot,
  snapshotBodies,
  pickBodiesById,
  type ShapeMapper,
} from './builderSnapshot'
import {
  registerBodyFaces,
  registerSolidAncestry,
  registerExtrusionFeature,
  reconcileFeatureSolids,
  snapshotWithBrepGeometry,
  bodyVersion,
  bodiesNeedingCheckpointRegistration,
  type MetaExtractor,
} from './builderAncestry'

// ─── Feature key union for dirty detection ───

const VOLATILE_FEATURE_KEYS = new Set([
  'drag_anchor',
])

// Extract a variable feature's published value from its solve result, or null
// for non-variable features / errored solves. The builder threads these into a
// `variableContext` so downstream expression fields (e.g. distance="width*2")
// and later variables resolve named references during the same build.
function variableValueOf(
  feature: Record<string, unknown>,
  result: Record<string, unknown> | undefined,
): { name: string; value: number } | null {
  if (feature.kind !== 'variable') return null
  const value = result?.value
  if (typeof value !== 'number' || !isFinite(value)) return null
  const name = String(feature.label ?? feature.id ?? '')
  return name ? { name, value } : null
}

function _normalizeSpec(spec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(spec)) {
    if (!VOLATILE_FEATURE_KEYS.has(k)) out[k] = spec[k]
  }
  return out
}

// ─── Dirty detection ───

/** Checkpoints own a deep copy of the spec: findFirstDirty hashes checkpoint
 *  spec content across builds, so aliasing the caller's doc would let an
 *  in-place edit between builds slip past dirty detection on both sides. */
function cloneSpec(feature: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(feature))
}

export function findFirstDirty(
  features: Array<Record<string, unknown>>,
  prevState: BuildState | null | undefined,
): number {
  if (!prevState) return 0
  const prevOrder = prevState.feature_order
  for (let i = 0; i < features.length; i++) {
    const feature = features[i]
    const fid = String(feature.id ?? '')
    if (i >= prevOrder.length || prevOrder[i] !== fid) return i
    const prevCheckpoint = prevState.checkpoints[fid]
    if (!prevCheckpoint) return i
    if (stableJson(_normalizeSpec(prevCheckpoint.spec as Record<string, unknown>))
        !== stableJson(_normalizeSpec(feature))) {
      return i
    }
  }
  return features.length
}

// ─── Validation ───

export function validateIncremental(
  incrementalState: BuildState,
  incrementalResult: Record<string, unknown>,
  doc: Record<string, unknown>,
  deps: BuildDeps,
): RebuildValidation {
  const docForFull = Object.fromEntries(Object.entries(doc).filter(([k]) => k !== '_validate'))
  const fresh = build(docForFull, { prevState: null }, deps)
  const freshState = fresh._build_state
  const freshResult = fresh.result as Record<string, unknown>

  // L1: spec hash per feature.
  for (const fid of incrementalState.feature_order) {
    const cpA = incrementalState.checkpoints[fid]
    const cpB = freshState.checkpoints[fid]
    if (!cpA || !cpB) {
      return { level: 1, passed: false, diffs: { missing_checkpoint: fid } }
    }
    if (hashCheckpointSpec(cpA) !== hashCheckpointSpec(cpB)) {
      return { level: 1, passed: false, diffs: { feature_id: fid } }
    }
  }

  // L2: result dict, strict then FP-tolerant.
  const incR = Object.fromEntries(incrementalState.feature_order.map((fid) => [fid, incrementalResult[fid]]))
  const freshR = Object.fromEntries(freshState.feature_order.map((fid) => [fid, freshResult[fid]]))
  if (hashResultDict(incR) !== hashResultDict(freshR)) {
    if (hashResultDict(incR, 4) === hashResultDict(freshR, 4)) {
      return { level: 2, passed: false, fp_only: true, diffs: { reason: 'floating-point drift within 4dp tolerance' } }
    }
    return { level: 3, passed: false, diffs: diffRepoSnapshot(incrementalState, freshState) }
  }

  // L3 final guard.
  const l3 = diffRepoSnapshot(incrementalState, freshState)
  if (Object.keys(l3).length) {
    return { level: 3, passed: false, diffs: l3 }
  }
  return { level: 3, passed: true, diffs: {} }
}

// ─── Mesh reuse helpers ───

// On a fully-clean rebuild (nothing dirty) the final bodies are byte-identical
// to the previous build's, so their render mesh is too. Reuse the final
// checkpoint's stored bodies_snapshot as `bodies` instead of re-tessellating the
// whole document. Returns null (fall through to a fresh tessellation) unless the
// rebuild is fully clean AND every live body maps to a non-empty prev snapshot.
function reuseFinalMeshOnCleanRebuild(
  prevState: BuildState | null | undefined,
  features: Array<Record<string, unknown>>,
  firstDirty: number,
  bodyStore: Record<string, Body>,
  lastFid: string | null,
): Record<string, Record<string, unknown>> | null {
  if (!prevState || lastFid == null) return null
  if (firstDirty !== features.length) return null
  const prevCp = prevState.checkpoints[lastFid]
  if (!prevCp) return null
  const snap = prevCp.bodies_snapshot as Record<string, Record<string, unknown>>
  if (!snap || !Object.keys(snap).length) return null
  const out: Record<string, Record<string, unknown>> = {}
  for (const [bid, body] of Object.entries(bodyStore)) {
    if (body.shape == null) continue
    const mesh = snap[bid]
    if (!mesh || !Object.keys(mesh).length) return null  // incomplete snapshot; re-tessellate
    out[bid] = mesh
  }
  return out
}

// Reuse the render mesh of imported bodies that are byte-identical to the
// previous solve, even when the tail is dirty. An imported body carries heavy
// STEP geometry (1000+ faces) whose tessellation is pure recomputation on every
// downstream edit. When the body's producing feature AND every feature that
// modified it sit in the clean prefix (indices < firstDirty), `findFirstDirty`
// guarantees its geometry is unchanged, so last solve's mesh is exact. The
// handle itself is NOT a usable cache key: the clean-prefix restore deep-copies
// each shape (BRepBuilderAPI_Copy), minting a fresh handle every solve.
//
// Returns a partial {bodyId -> reused render result} covering only the reusable
// imported bodies; the caller tessellates the rest. Empty on a fully-clean
// rebuild (handled by reuseFinalMeshOnCleanRebuild) or a full rebuild (nothing
// clean). The source is the previous solve's final checkpoint snapshot, the only
// place a full render mesh is stored.
function reuseCleanImportedBodyMeshes(
  prevState: BuildState | null | undefined,
  firstDirty: number,
  bodyStore: Record<string, Body>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  if (!prevState || firstDirty <= 0) return out
  const cleanFids = new Set(prevState.feature_order.slice(0, firstDirty))
  const prevLastFid = prevState.feature_order[prevState.feature_order.length - 1]
  if (prevLastFid == null) return out
  const prevSnap = prevState.checkpoints[prevLastFid]?.bodies_snapshot as
    | Record<string, Record<string, unknown>>
    | undefined
  if (!prevSnap) return out
  for (const [bid, body] of Object.entries(bodyStore)) {
    if (body.shape == null || !body.imported) continue
    // Wholly produced within the clean prefix => geometry unchanged this solve.
    if (!cleanFids.has(body.created_by)) continue
    if (body.modified_by.some((fid) => !cleanFids.has(fid))) continue
    const mesh = prevSnap[bid]
    if (mesh && Object.keys(mesh).length) out[bid] = mesh
  }
  return out
}

// The same reuse for the PICK world (the body set before the edited feature).
// Only the final feature's checkpoint stores a render mesh, so a pick boundary
// anywhere else re-tessellated the whole document -- and it never self-healed,
// because a clean-prefix checkpoint is carried over verbatim and keeps its empty
// bodies_snapshot, so the cost repeated on every solve while the editor stayed
// open. With a heavy STEP import behind the edit that was 25% of a full import
// each time.
//
// `finalBodies` is the guard this wrapper exists for: the mesh on offer comes
// from the previous solve's FINAL checkpoint, but a body can be clean at the
// pick boundary and still be modified by a later clean-prefix feature, in which
// case that mesh is the wrong shape for the pick world. `modified_by` only ever
// appends and the pick-checkpoint history is a prefix of the final one, so equal
// lengths is an exact "same shape in both worlds" test. A body the edited
// feature deletes is absent from the live store and falls through to a real
// tessellation -- correct, and it is one body rather than all of them.
function reusePickBodyMeshes(
  prevState: BuildState | null | undefined,
  firstDirty: number,
  pickBodies: Record<string, Body>,
  finalBodies: Record<string, Body>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [bid, mesh] of Object.entries(reuseCleanImportedBodyMeshes(prevState, firstDirty, pickBodies))) {
    const live = finalBodies[bid]
    if (!live || live.modified_by.length !== pickBodies[bid].modified_by.length) continue
    out[bid] = mesh
  }
  return out
}

// ─── Build orchestration ───

export function build(
  spec: Record<string, unknown>,
  options: BuildOptions,
  deps: BuildDeps,
): BuildResponse {
  const t0 = performance.now()

  const allFeatures = (spec.features as Array<Record<string, unknown>> ?? [])
    .map((f) => deps.normalizeProjectedEntities ? deps.normalizeProjectedEntities(f) : f)
  const features = options.rollbackPosition != null
    ? allFeatures.slice(0, options.rollbackPosition)
    : allFeatures

  const firstDirty = findFirstDirty(features, options.prevState)

  // Evict the prev-state checkpoints this build discards: everything from the
  // first dirty feature onward (the clean prefix, indices < firstDirty, is
  // reused by identity below and keeps its retained shapes). Deleted features
  // sit at or past firstDirty in the prev order, so they are covered too. Each
  // checkpoint owns its shapes exclusively (defensive copies), so releasing by
  // owner frees exactly that checkpoint's copies. The previous build's restore
  // copies are released here too -- their replacement is minted in the restore
  // below, and this is the only point where the outgoing generation is known.
  if (options.prevState && deps.releaseCheckpoint) {
    for (const fid of options.prevState.feature_order.slice(firstDirty)) {
      deps.releaseCheckpoint(fid)
    }
    deps.releaseRestoreCopies?.()
  }

  const globalRepo = deps.initGlobalRepo()
  const bodyStore: Record<string, Body> = {}
  const result: Record<string, unknown> = {}
  const newCheckpoints: Record<string, FeatureCheckpoint> = {}

  // Mesh-free metadata is a pure function of a body's shape, but it is asked for
  // twice over: once per feature in the solve loop (`registerBodyFaces`) and
  // again per dirty checkpoint, where every checkpoint snapshots the WHOLE body
  // store. An untouched body -- typically the heavy imported one -- was
  // therefore re-read once per feature behind it, so each edit cost more the
  // longer the stack grew. One read per distinct body version is enough. (The
  // checkpoint pass now also asks only for the bodies it still has to register,
  // which is usually none; the cache remains the guard for the rest.)
  //
  // `bodyVersion` is the identity the builder already trusts elsewhere (see the
  // `modified_by.length` re-registration check in the solve loop): a feature
  // that changes a body registers a new shape handle and appends to
  // `modified_by`. The cache lives for one build only, so it can never serve a
  // handle from a previous solve -- the clean-prefix restore deep-copies each
  // shape and mints fresh handles.
  //
  // Both real extractors ignore the `repo` argument (identification reads the
  // B-rep, not the repo), so a hit is valid regardless of which call site filled
  // it; a miss still forwards the caller's repo through.
  const extractMeta = deps.extractBrepMetadata ?? deps.tessellateBodies
  const metaCache = new Map<string, Record<string, unknown>>()
  const extractMetaCached: MetaExtractor = (snapshot, repo) => {
    const out: Record<string, Record<string, unknown>> = {}
    const missing: Record<string, Body> = {}
    for (const [bid, body] of Object.entries(snapshot)) {
      const hit = body.shape != null ? metaCache.get(bodyVersion(body)) : undefined
      if (hit) out[bid] = hit
      else missing[bid] = body
    }
    if (Object.keys(missing).length) {
      const fresh = extractMeta(missing, repo)
      for (const [bid, meta] of Object.entries(fresh)) {
        out[bid] = meta
        const body = missing[bid]
        if (body?.shape != null) metaCache.set(bodyVersion(body), meta)
      }
    }
    return out
  }

  // Preserve previous topology on full rebuild so area re-ID can fire after
  // entity deletions.
  if (options.prevState && firstDirty === 0) {
    for (const feature of features) {
      const fid = String(feature.id ?? '')
      const prevCp = options.prevState.checkpoints[fid]
      if (!prevCp) continue
      const prevTopo = (prevCp.repo_snapshot as Record<string, unknown>).elements as Record<string, unknown> | undefined
      if (prevTopo && ('_topo_' + fid) in prevTopo) {
        globalRepo.elements.set('_topo_' + fid, prevTopo['_topo_' + fid])
      }
    }
  }

  // Restore clean prefix from prev_state.
  if (options.prevState && firstDirty > 0) {
    const lastCleanFid = String(features[firstDirty - 1].id ?? '')
    const checkpoint = options.prevState.checkpoints[lastCleanFid]
    if (checkpoint) {
      Object.assign(globalRepo, repoFromSnapshot(checkpoint.repo_snapshot as Record<string, unknown>))
      // Copy the checkpoint's retained shapes into the live store: the rebuilt
      // tail may consume/free these, so they must be independent of the pristine
      // checkpoint shapes that future rebuilds restore from again. Each copy is
      // registered under RESTORE_OWNER so the next build's eviction frees it.
      Object.assign(
        bodyStore,
        snapshotBodies(
          checkpoint.body_store_snapshot,
          deps.copyBodyShape ? (shape) => deps.copyBodyShape!(shape, RESTORE_OWNER) : undefined,
        ),
      )
      // Null out brep_diff on restored bodies: the diff's sub-shape handles
      // are dead OCC proxies from the previous build scope. The builder-side
      // callers (ancestry registration) fall back to body.created_by when
      // brep_diff is null, and the pick-side guard in buildEdgeIndex already
      // handles the null case.
      for (const body of Object.values(bodyStore)) {
        body.brep_diff = null
      }
      for (const fid of options.prevState.feature_order.slice(0, firstDirty)) {
        result[fid] = options.prevState.checkpoints[fid].result
        newCheckpoints[fid] = options.prevState.checkpoints[fid]
      }
    }
  }

  const registeredBodyIds = new Set(Object.keys(bodyStore))

  // Fids that own at least one shaped body, so `reconcileFeatureSolids` can exit in
  // O(1) for the many features that own none. The body pass below refreshes it from
  // the live store every feature, so bodies a solve creates mid-loop count too; it
  // only ever grows, which over-approximates (an owning feature whose body died still
  // reconciles, a harmless scan) but never under-approximates a current owner.
  const shapeOwningFids = new Set<string>()
  for (const body of Object.values(bodyStore)) {
    if (body.shape != null && body.created_by) shapeOwningFids.add(body.created_by)
  }

  // Body version -> "its B-rep ancestry is in `globalRepo` right now", so the post-loop
  // checkpoint pass can tell what a checkpoint's own snapshot already carries. Clean-prefix
  // bodies count as registered without being touched this build: their ancestry arrived
  // with the restored snapshot above, which is exactly the state every checkpoint of this
  // build is snapshotted from.
  // Keyed by body-store key, matching both the loop's writes and the consumer's reads.
  // Identical to `body.id` for every body the kernel builds, but keying two sides of a
  // lookup differently is the kind of thing that survives until it does not.
  const registeredVersions = new Map<string, string>()
  for (const [bodyId, body] of Object.entries(bodyStore)) registeredVersions.set(bodyId, bodyVersion(body))
  // Per checkpoint, the map as it stood when that checkpoint was snapshotted. O(bodies)
  // per checkpoint, and build-local scaffolding only -- never part of the persisted
  // `FeatureCheckpoint`.
  const registeredAtCheckpoint = new Map<string, Map<string, string>>()

  globalRepo.setFeatureOrder(allFeatures.map((f) => String(f.id ?? '')))

  const featuresById = Object.fromEntries(allFeatures.map((f) => [String(f.id ?? ''), f]))

  // Accumulate named-variable values in feature order. Seed from the restored
  // clean prefix (those variables are not re-solved this build) so a dirty
  // downstream feature still resolves a variable defined before the dirty point.
  const variableContext: Record<string, number> = {}
  for (let i = 0; i < firstDirty && i < features.length; i++) {
    const f = features[i]
    const vv = variableValueOf(f, result[String(f.id ?? '')] as Record<string, unknown> | undefined)
    if (vv) variableContext[vv.name] = vv.value
  }

  // Snapshot mapper: retain the live shape under the checkpoint's owner so it
  // survives a downstream consume/free and into the next build, without copying
  // it (copying a shape a later feature then operates on corrupts that result).
  const retainForCheckpoint = (fid: string): ShapeMapper | undefined => {
    if (!deps.retainCheckpointShape) return undefined
    const retain = deps.retainCheckpointShape
    return (shape) => { retain(shape, 'cp:' + fid); return shape }
  }

  for (const feature of features.slice(firstDirty)) {
    const fid = String(feature.id ?? '')

    if (feature.suppressed) {
      const cpSnapshot = snapshotBodies(bodyStore, retainForCheckpoint(fid))
      newCheckpoints[fid] = {
        spec: cloneSpec(feature),
        result: { status: 'suppressed' },
        repo_snapshot: snapshotRepo(globalRepo),
        body_store_snapshot: cpSnapshot,
        bodies_snapshot: {},
      }
      registeredAtCheckpoint.set(fid, new Map(registeredVersions))
      result[fid] = { status: 'suppressed' }
      continue
    }

    // Each body as it stood going in: how long `modified_by` was (a longer one
    // after the solve means the feature modified it) and who owned it (so a body
    // this feature CONSUMES can still be evicted below -- the store entry, and
    // with it `created_by`, is gone by then). A body both created AND consumed
    // inside one feature is invisible here; no solver does that today, a
    // boolean's tools must pre-exist.
    const before: Record<string, { modifiedByLen: number; createdBy: string }> = {}
    for (const [bid, b] of Object.entries(bodyStore)) {
      before[bid] = { modifiedByLen: b.modified_by.length, createdBy: b.created_by || '' }
    }

    setCurrentFeatureId(fid)
    try {
      const t0 = performance.now()
      const featureResult = deps.trySolveFeature(feature, globalRepo, bodyStore, featuresById, variableContext)
      featureResult.solve_ms = performance.now() - t0
      deps.postRegister(globalRepo, fid, feature, featureResult)
      result[fid] = featureResult
      const vv = variableValueOf(feature, featureResult)
      if (vv) variableContext[vv.name] = vv.value
    } catch (e) {
      const err = extractErrorMessage(e)
      result[fid] = { status: 'exception', exception: err, solve_ms: 0 }
    } finally {
      setCurrentFeatureId(null)
    }

    // A body the feature consumed (a boolean tool, a fused array source) is out of
    // the store but still fully registered: its faces stay live carrying the very
    // construction UUIDs the surviving body inherited from them, which the
    // resolver's UUID tier then reports as a "collision by construction" on every
    // pick of such a face. Evict it here, where the disappearance is observable,
    // rather than in each consuming solver.
    for (const [bodyId, was] of Object.entries(before)) {
      if (bodyId in bodyStore) continue
      clearConsumedBodyAncestry(globalRepo, bodyId, was.createdBy)
      registeredBodyIds.delete(bodyId)
      registeredVersions.delete(bodyId)
    }

    for (const [bodyId, body] of Object.entries(bodyStore)) {
      if (body.shape != null && body.created_by) shapeOwningFids.add(body.created_by)
      if (!registeredBodyIds.has(bodyId) && body.shape != null) {
        // Only a registration that LANDED may be recorded: an identification failure is
        // silent and per body, and the checkpoint pass reads a different producer, so
        // recording a failure here would skip the one pass that could still recover it.
        // Solid/extrusion ancestry is unconditional, so it survives either way.
        const landed = registerBodyFaces(globalRepo, body, deps, extractMetaCached)
        registerSolidAncestry(globalRepo, body)
        registerExtrusionFeature(globalRepo, body.created_by || '', body.sketch_id)
        registeredBodyIds.add(bodyId)
        if (landed) registeredVersions.set(bodyId, bodyVersion(body))
      } else if (body.shape != null && body.modified_by.length > (before[bodyId]?.modifiedByLen ?? 0)) {
        // Body was modified; re-register faces so downstream features see updates. A
        // failed re-registration must also drop the stale entry: the snapshot now holds
        // the PREVIOUS version's ancestry, which is not what this checkpoint carries.
        if (registerBodyFaces(globalRepo, body, deps, extractMetaCached)) {
          registeredVersions.set(bodyId, bodyVersion(body))
        } else {
          registeredVersions.delete(bodyId)
        }
      }
    }

    // postRegister wiped this feature's `[@fid]` entries wholesale, and the body loop
    // only re-registered solids for bodies it just created. Reconcile so the entry
    // matches the body store for every body the feature owns, or a cosmetic re-solve
    // leaves `?@fid:solid` unresolvable into every later checkpoint.
    reconcileFeatureSolids(globalRepo, fid, bodyStore, shapeOwningFids)

    const cpSnapshot = snapshotBodies(bodyStore, retainForCheckpoint(fid))
    newCheckpoints[fid] = {
      spec: cloneSpec(feature),
      result: JSON.parse(JSON.stringify(result[fid])),
      repo_snapshot: snapshotRepo(globalRepo),
      body_store_snapshot: cpSnapshot,
      bodies_snapshot: {},
    }
    registeredAtCheckpoint.set(fid, new Map(registeredVersions))
  }

  const activeFids = new Set(allFeatures.map((f) => String(f.id ?? '')))
  globalRepo.gc(activeFids)

  // Clean prefix: checkpoints carried over verbatim from prevState (indices
  // < firstDirty). On a fully-clean rebuild (firstDirty === features.length)
  // every checkpoint is a clean-prefix carry-over, including the last one.
  const cleanPrefixFids = new Set<string>()
  if (options.prevState && firstDirty > 0) {
    for (const fid of options.prevState.feature_order.slice(0, firstDirty)) {
      cleanPrefixFids.add(fid)
    }
  }

  // The final feature's checkpoint owns the one render mesh we always keep (for
  // display + an end-of-stack pick). Every earlier checkpoint stays lazy: its
  // bodies_snapshot is empty and the pick path tessellates it on demand.
  const lastFid = features.length ? String(features[features.length - 1].id ?? '') : null

  // On a fully-clean rebuild the final bodies are unchanged, so reuse the prior
  // build's final render mesh instead of re-tessellating the whole document.
  // Otherwise, still reuse the render mesh of any clean-prefix imported body
  // (unchanged heavy STEP geometry) and tessellate only the remaining bodies.
  const bodiesOut =
    reuseFinalMeshOnCleanRebuild(options.prevState, features, firstDirty, bodyStore, lastFid)
    ?? (() => {
      const reused = reuseCleanImportedBodyMeshes(options.prevState, firstDirty, bodyStore)
      const toTessellate = Object.fromEntries(
        Object.entries(bodyStore).filter(([bid]) => !(bid in reused)),
      )
      return { ...reused, ...deps.tessellateBodies(toTessellate, globalRepo) }
    })()

  // Rebuild checkpoints for dirty features: attach the render mesh to the final one, and
  // register the B-rep ancestry of any body the solve loop did NOT already register into
  // that checkpoint's own repo snapshot. Usually that is no body at all -- the snapshot is
  // taken after the loop's registration pass, so it already carries the ancestry, and
  // re-registering it only churned eids for the same payloads, once per checkpoint.
  // The remainder still gets its pass here: a null-shape body, a body whose shape handle
  // moved (the `modified_by` check in the loop misses a body that changed without a push,
  // `bodyVersion` does not), and a body whose loop-side identification failed -- that last
  // one is why this pass is a recovery path and not just a fallback, since it reads a
  // different producer. Pure non-OCC tests wire no extractor, so the metadata read falls
  // back to tessellateBodies.
  for (const fid of Object.keys(newCheckpoints)) {
    if (cleanPrefixFids.has(fid)) continue
    const checkpoint = newCheckpoints[fid]
    const isLast = fid === lastFid
    const needing = bodiesNeedingCheckpointRegistration(
      checkpoint.body_store_snapshot,
      registeredAtCheckpoint.get(fid) ?? new Map(),
    )
    // The final checkpoint reuses the render tessellation (bodiesOut) for BOTH
    // its display snapshot and its B-rep ancestry -- that mesh already carries
    // face_data/edges/queries, so re-extracting metadata for it would be wasted
    // work. It is safe to skip the same way the others do: registering off the render
    // mesh and off the mesh-free metadata is proven to produce identical ancestry
    // (`checkpointRegistrationReal.test.ts`), which is what makes the loop's
    // metadata-based registration count for this checkpoint too. Earlier checkpoints
    // identify off cheap mesh-free metadata and stay lazy (empty bodies snapshot).
    // Same error contract as the solve loop: a metadata read that throws (a future
    // BuildDeps that does not shield per body the way the real extractors do) costs the
    // needing bodies their ancestry for THIS checkpoint, not the whole build. Batch
    // granularity, not per body: `needing` is usually empty and the real extractors
    // already isolate each body, so one call per needing body buys nothing.
    let cpMeta: Record<string, Record<string, unknown>>
    try {
      cpMeta = isLast
        ? bodiesOut
        : extractMetaCached(pickBodiesById(checkpoint.body_store_snapshot, needing), null)
    } catch {
      cpMeta = {}
    }
    const bodiesSnapshot = isLast
      ? Object.fromEntries(
          Object.keys(checkpoint.body_store_snapshot).map((bid) => [bid, bodiesOut[bid] ?? {}]),
        )
      : {}
    newCheckpoints[fid] = {
      spec: checkpoint.spec,
      result: checkpoint.result,
      repo_snapshot: snapshotWithBrepGeometry(checkpoint, cpMeta, deps, needing),
      body_store_snapshot: checkpoint.body_store_snapshot,
      bodies_snapshot: bodiesSnapshot,
    }
  }

  const buildMs = Math.round((performance.now() - t0) * 10) / 10

  const newState: BuildState = {
    feature_order: allFeatures.map((f) => String(f.id ?? '')),
    checkpoints: newCheckpoints,
  }

  let pickBodiesOut: Record<string, unknown> | undefined
  const pickBoundary = options.pickBoundary
  if (pickBoundary != null && pickBoundary >= 0 && pickBoundary <= features.length) {
    if (pickBoundary === 0) {
      // Boundary 0 edits the first feature: the "before" state is the empty
      // doc, there is nothing to pick against. Carry {} so the main thread
      // still enters the 'editing' world (empty pick bodies) like any other
      // boundary, matching the unavailable-checkpoint contract below.
      pickBodiesOut = {}
    } else {
      const targetFid = String(features[pickBoundary - 1].id ?? '')
      const pickCheckpoint = newCheckpoints[targetFid] ?? options.prevState?.checkpoints[targetFid]
      if (pickCheckpoint) {
        const snap = pickCheckpoint.bodies_snapshot
        if (Object.keys(snap).length) {
          pickBodiesOut = snap
        } else {
          const pickStore = pickCheckpoint.body_store_snapshot
          const reused = reusePickBodyMeshes(options.prevState, firstDirty, pickStore, bodyStore)
          const toTessellate = Object.fromEntries(
            Object.entries(pickStore).filter(([bid]) => !(bid in reused)),
          )
          pickBodiesOut = { ...reused, ...deps.tessellateBodies(toTessellate, null) }
        }
      } else {
        // Checkpoint not found (e.g. prevState was null on first solve, or the
        // checkpoint was evicted between solves). Return empty so the caller
        // clears stale pick_bodies state instead of silently keeping it.
        pickBodiesOut = {}
      }
    }
  }

  // Builtin planes are always addressable in the result.
  Object.assign(result, BUILTIN_PLANE_RESULTS)

  const response: BuildResponse = {
    solve_ms: buildMs,
    result,
    bodies: bodiesOut,
    _build_state: newState,
    ...(pickBodiesOut ? { pick_bodies: pickBodiesOut } : {}),
  }

  if (spec._validate) {
    // The comparison build runs on the throwaway wiring when provided, and
    // that wiring is disposed as soon as the diff is computed: it owns the
    // whole inner generation.
    const iso = deps.isolatedValidationDeps?.()
    try {
      response._validation = validateIncremental(newState, result, spec, iso ? iso.deps : deps)
    } finally {
      iso?.dispose()
    }
  }

  return response
}

// ─── Moved public surface ───
//
// Kept re-exported here so existing importers keep reaching these through the
// builder, the module that owns the solve entry points.

export type {
  FeatureResult,
  FeatureSolver,
  BuildDeps,
  BuildOptions,
  BuildResponse,
  RebuildValidation,
} from './builderTypes'
export { stableJson, hashCheckpointSpec, hashResultDict } from './builderHash'
export { RESTORE_OWNER, snapshotRepo, repoFromSnapshot } from './builderSnapshot'
export {
  edgeAncestryPayload,
  registerBodyBrepFromMeta,
  bodyVersion,
  bodiesNeedingCheckpointRegistration,
} from './builderAncestry'

// ─── TS kernel router ───
//
// The solver registry provides the per-doc solvability gate: a kind-set
// membership check that dispatches a doc to the TS/WASM leaf solvers when
// every feature kind is ported, else the doc cannot be solved at all.
// The gate is re-exported here so the solver hook reaches it through the
// builder, the same module that owns the solve entry points.
export { isDocFullyPorted, unportedKinds } from './solverRegistry'
