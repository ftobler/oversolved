// Orchestrates the feature-stack solve loop with dirty detection, checkpoint cache, and
// incremental rebuild. Feature solvers are injected via a registry, so this module stays
// testable with mock solvers.
//
// Ancestry registration, snapshot/restore and the hash/validation helpers live in
// sibling modules (builderAncestry.ts, builderSnapshot.ts, builderHash.ts); this file
// stays the orchestrator and re-exports the public surface those modules used to expose.

import { extractErrorMessage, isKernelTrap } from './errors'
import { clearConsumedPartAncestry, setCurrentFeatureId, type Repository } from './query'
import { nextMacrotask } from './nextMacrotask'
import { partialBuildState, type PartialBuild } from './builderPartial'
import { BUILTIN_PLANE_RESULTS } from './solverConstants'
import { markFeatureStart, clearFeatureProgress } from './featureProgress'
import type { PartSolid, FeatureCheckpoint, BuildState } from './types3d'
import {
  type BuildDeps,
  type BuildOptions,
  type BuildResponse,
  type RebuildValidation,
} from './builderTypes'
import { stableJson, hashCheckpointSpec, hashResultDict, diffRepoSnapshot } from './builderHash'
import { laterVariablesAt } from './features/variable'
import { resolveTouchWarnings } from './resolveTouchWarnings'
import {
  RESTORE_OWNER,
  snapshotRepo,
  repoFromSnapshot,
  snapshotParts,
  pickPartsById,
  type ShapeMapper,
} from './builderSnapshot'
import {
  registerPartFaces,
  registerSolidAncestry,
  registerExtrusionFeature,
  reconcileFeatureSolids,
  snapshotWithBrepGeometry,
  partVersion,
  partsNeedingCheckpointRegistration,
  type MetaExtractor,
} from './builderAncestry'
import {
  PartChangeTracker,
  renderFinalParts,
  renderPickParts,
  boundCheckpointMeshes,
  verifyReusedMeshes,
} from './builderMeshReuse'

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
  // Checkpoints are keyed by id, so a repeated id (an imported or hand-edited
  // doc; commands mint fresh ids) leaves one checkpoint for several features.
  // It describes whichever copy was built last, never safely the one at i, so
  // the clean prefix must stop before it, in either build's order.
  const repeated = new Set<string>()
  for (const order of [features.map((f) => String(f.id ?? '')), prevOrder]) {
    const seen = new Set<string>()
    for (const fid of order) {
      if (seen.has(fid)) repeated.add(fid)
      seen.add(fid)
    }
  }
  for (let i = 0; i < features.length; i++) {
    const feature = features[i]
    const fid = String(feature.id ?? '')
    if (repeated.has(fid)) return i
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

// ─── Build orchestration ───

/** The document a build takes: the solve payload, still an untyped clone here. */
type BuildSpec = Record<string, unknown>

/** What `buildSteps` yields after each feature's checkpoint is stored. */
export interface BuildStep {
  // Index (in the build's feature list) of the feature that just finished.
  featureIndex: number
  // The state a build stopped here leaves behind; computed on demand.
  partial: () => PartialBuild
}

/** A build `buildAbortable` stopped between two features. */
export interface BuildAborted extends PartialBuild {
  aborted: true
}

/** Run a build to completion synchronously: the entry every caller that needs
 *  a result in one call uses (exports, validation, bundles, headless drive). */
export function build(
  spec: BuildSpec,
  options: BuildOptions,
  deps: BuildDeps,
): BuildResponse {
  const steps = buildSteps(spec, options, deps)
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
  }
}

/**
 * Run a build that yields a macrotask after each feature and stops there once
 * `shouldAbort()` is true, so a request that obsoletes it can land and cut it
 * short. A stop releases this build's restore copies and the retains of every
 * solved checkpoint the partial state drops, and returns that state: a valid
 * prevState for the next build, which resumes at the first missing checkpoint.
 * A trap still throws out of the step that hit it, as in `build`.
 */
export async function buildAbortable(
  spec: BuildSpec,
  options: BuildOptions,
  deps: BuildDeps,
  shouldAbort: () => boolean,
  yieldNow: () => Promise<void> = nextMacrotask,
): Promise<BuildResponse | BuildAborted> {
  const steps = buildSteps(spec, options, deps)
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
    await yieldNow()
    if (!shouldAbort()) continue
    const partial = step.value.partial()
    // The restore copies were the only extra owner of the live store's shapes;
    // the kept checkpoints retain theirs under `cp:<fid>`.
    deps.releaseRestoreCopies?.()
    for (const fid of partial.dropped) deps.releaseCheckpoint?.(fid)
    clearFeatureProgress()
    return { aborted: true, ...partial }
  }
}

/**
 * The build as a stepper: it yields after each feature's checkpoint is stored
 * and returns the response after the post-loop pass (`finishBuild`). Nothing
 * outside one feature's solve is half-done at a yield, which is what makes the
 * partial state of a stopped build coherent.
 */
export function* buildSteps(
  spec: BuildSpec,
  options: BuildOptions,
  deps: BuildDeps,
): Generator<BuildStep, BuildResponse, void> {
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
  const partStore: Record<string, PartSolid> = {}
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
  const extractMeta = deps.extractBrepMetadata ?? deps.tessellateParts
  const metaCache = new Map<string, Record<string, unknown>>()
  const extractMetaCached: MetaExtractor = (snapshot, repo) => {
    const out: Record<string, Record<string, unknown>> = {}
    const missing: Record<string, PartSolid> = {}
    for (const [bid, body] of Object.entries(snapshot)) {
      const hit = body.shape != null ? metaCache.get(partVersion(body)) : undefined
      if (hit) out[bid] = hit
      else missing[bid] = body
    }
    if (Object.keys(missing).length) {
      const fresh = extractMeta(missing, repo)
      for (const [bid, meta] of Object.entries(fresh)) {
        out[bid] = meta
        const part = missing[bid]
        if (part?.shape != null) metaCache.set(partVersion(part), meta)
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
        partStore,
        snapshotParts(
          checkpoint.body_store_snapshot,
          deps.copyPartShape ? (shape) => deps.copyPartShape!(shape, RESTORE_OWNER) : undefined,
        ),
      )
      // Null out brep_diff on restored bodies: the diff's sub-shape handles
      // are dead OCC proxies from the previous build scope. The builder-side
      // callers (ancestry registration) fall back to body.created_by when
      // brep_diff is null, and the pick-side guard in buildEdgeIndex already
      // handles the null case.
      for (const part of Object.values(partStore)) {
        part.brep_diff = null
      }
      for (const fid of options.prevState.feature_order.slice(0, firstDirty)) {
        result[fid] = options.prevState.checkpoints[fid].result
        newCheckpoints[fid] = options.prevState.checkpoints[fid]
      }
    }
  }

  // Which feature last changed each body's render inputs: the provenance the
  // final mesh carries into the next build (kernel/builderMeshReuse.ts).
  const changes = new PartChangeTracker()
  changes.markRestored(partStore)

  const registeredPartIds = new Set(Object.keys(partStore))

  // Fids that own at least one shaped body, so `reconcileFeatureSolids` can exit in
  // O(1) for the many features that own none. The body pass below refreshes it from
  // the live store every feature, so bodies a solve creates mid-loop count too; it
  // only ever grows, which over-approximates (an owning feature whose body died still
  // reconciles, a harmless scan) but never under-approximates a current owner.
  const shapeOwningFids = new Set<string>()
  for (const part of Object.values(partStore)) {
    if (part.shape != null && part.created_by) shapeOwningFids.add(part.created_by)
  }

  // Part version -> "its B-rep ancestry is in `globalRepo` right now", so the post-loop
  // checkpoint pass can tell what a checkpoint's own snapshot already carries. Clean-prefix
  // bodies count as registered without being touched this build: their ancestry arrived
  // with the restored snapshot above, which is exactly the state every checkpoint of this
  // build is snapshotted from.
  // Keyed by body-store key, matching both the loop's writes and the consumer's reads.
  // Identical to `body.id` for every body the kernel builds, but keying two sides of a
  // lookup differently is the kind of thing that survives until it does not.
  const registeredVersions = new Map<string, string>()
  for (const [bodyId, body] of Object.entries(partStore)) registeredVersions.set(bodyId, partVersion(body))
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

  const featureOrder = allFeatures.map((f) => String(f.id ?? ''))
  const featureFids = features.map((f) => String(f.id ?? ''))
  const stepAt = (featureIndex: number): BuildStep => ({
    featureIndex,
    partial: () => partialBuildState({
      featureOrder,
      fids: featureFids,
      firstDirty,
      builtThrough: featureIndex,
      checkpoints: newCheckpoints,
      registeredAtCheckpoint,
      // The post-loop registration pass for one non-final checkpoint, with the
      // same error contract: a metadata read that throws costs the needing
      // bodies their ancestry, a trap still kills the solve.
      complete: (cp, needing) => {
        let meta: ReturnType<MetaExtractor>
        try {
          meta = extractMetaCached(pickPartsById(cp.body_store_snapshot, needing), null)
        } catch (e) {
          if (isKernelTrap(e)) throw e
          meta = {}
        }
        return { ...cp, repo_snapshot: snapshotWithBrepGeometry(cp, meta, needing) }
      },
    }),
  })

  for (let featureIndex = firstDirty; featureIndex < features.length; featureIndex++) {
    const feature = features[featureIndex]
    const fid = String(feature.id ?? '')

    if (feature.suppressed) {
      const cpSnapshot = snapshotParts(partStore, retainForCheckpoint(fid))
      newCheckpoints[fid] = {
        spec: cloneSpec(feature),
        result: { status: 'suppressed' },
        repo_snapshot: snapshotRepo(globalRepo),
        body_store_snapshot: cpSnapshot,
        bodies_snapshot: {},
      }
      registeredAtCheckpoint.set(fid, new Map(registeredVersions))
      result[fid] = { status: 'suppressed' }
      yield stepAt(featureIndex)
      continue
    }

    // Each body as it stood going in: how long `modified_by` was (a longer one
    // after the solve means the feature modified it) and who owned it (so a body
    // this feature CONSUMES can still be evicted below -- the store entry, and
    // with it `created_by`, is gone by then). A body both created AND consumed
    // inside one feature is invisible here; no solver does that today, a
    // boolean's tools must pre-exist.
    const before: Record<string, { modifiedByLen: number; createdBy: string }> = {}
    for (const [bid, b] of Object.entries(partStore)) {
      before[bid] = { modifiedByLen: b.modified_by.length, createdBy: b.created_by || '' }
    }

    setCurrentFeatureId(fid)
    markFeatureStart(fid)
    try {
      const t0 = performance.now()
      const featureResult = deps.trySolveFeature(
        feature, globalRepo, partStore, featuresById, variableContext,
        laterVariablesAt(features, featureIndex, variableContext),
      )
      featureResult.solve_ms = performance.now() - t0
      deps.postRegister(globalRepo, fid, feature, featureResult, featuresById)
      result[fid] = featureResult
      const vv = variableValueOf(feature, featureResult)
      if (vv) variableContext[vv.name] = vv.value
    } catch (e) {
      // A WASM trap is not a feature verdict. Recording it as `exception` used
      // to swallow it here, leaving the solve on a corrupt heap and reporting a
      // feature error for what is actually a dead kernel.
      if (isKernelTrap(e)) throw e
      const err = extractErrorMessage(e)
      result[fid] = { status: 'exception', exception: err, solve_ms: 0 }
    } finally {
      setCurrentFeatureId(null)
    }
    // Before the snapshot and the registration below read the bodies, and
    // even after a failed solve: a solver can modify a body and then throw.
    deps.indexModifierDiffs?.(partStore)
    // After the diffs are indexed: they rewrite `brep_new` and the owner maps,
    // which the render reads.
    changes.observe(fid, partStore)

    // A body the feature consumed (a boolean tool, a fused array source) is out of
    // the store but still fully registered: its faces stay live carrying the very
    // construction UUIDs the surviving body inherited from them, which the
    // resolver's UUID tier then reports as a "collision by construction" on every
    // pick of such a face. Evict it here, where the disappearance is observable,
    // rather than in each consuming solver.
    for (const [bodyId, was] of Object.entries(before)) {
      if (bodyId in partStore) continue
      clearConsumedPartAncestry(globalRepo, bodyId, was.createdBy)
      registeredPartIds.delete(bodyId)
      registeredVersions.delete(bodyId)
    }

    for (const [bodyId, body] of Object.entries(partStore)) {
      if (body.shape != null && body.created_by) shapeOwningFids.add(body.created_by)
      if (!registeredPartIds.has(bodyId) && body.shape != null) {
        // Only a registration that LANDED may be recorded: an identification failure is
        // silent and per body, and the checkpoint pass reads a different producer, so
        // recording a failure here would skip the one pass that could still recover it.
        // Solid/extrusion ancestry is unconditional, so it survives either way.
        const landed = registerPartFaces(globalRepo, body, deps, extractMetaCached)
        registerSolidAncestry(globalRepo, body)
        registerExtrusionFeature(globalRepo, body.created_by || '', body.sketch_id)
        registeredPartIds.add(bodyId)
        if (landed) registeredVersions.set(bodyId, partVersion(body))
      } else if (body.shape != null && body.modified_by.length > (before[bodyId]?.modifiedByLen ?? 0)) {
        // Part was modified; re-register faces so downstream features see updates. A
        // failed re-registration must also drop the stale entry: the snapshot now holds
        // the PREVIOUS version's ancestry, which is not what this checkpoint carries.
        if (registerPartFaces(globalRepo, body, deps, extractMetaCached)) {
          registeredVersions.set(bodyId, partVersion(body))
        } else {
          registeredVersions.delete(bodyId)
        }
      }
    }

    // postRegister wiped this feature's `[@fid]` entries wholesale, and the body loop
    // only re-registered solids for bodies it just created. Reconcile so the entry
    // matches the body store for every body the feature owns, or a cosmetic re-solve
    // leaves `?@fid:solid` unresolvable into every later checkpoint.
    reconcileFeatureSolids(globalRepo, fid, partStore, shapeOwningFids)

    const cpSnapshot = snapshotParts(partStore, retainForCheckpoint(fid))
    newCheckpoints[fid] = {
      spec: cloneSpec(feature),
      result: JSON.parse(JSON.stringify(result[fid])),
      repo_snapshot: snapshotRepo(globalRepo),
      body_store_snapshot: cpSnapshot,
      bodies_snapshot: {},
    }
    registeredAtCheckpoint.set(fid, new Map(registeredVersions))
    yield stepAt(featureIndex)
  }

  return finishBuild({
    spec, options, deps, t0, featureOrder, featureFids, firstDirty,
    globalRepo, partStore, result, newCheckpoints, changes, registeredAtCheckpoint,
    extractMetaCached,
  })
}

/** Everything the solve loop hands the post-loop pass. */
interface LoopOutcome {
  spec: BuildSpec
  options: BuildOptions
  deps: BuildDeps
  t0: number
  // Ids of the whole document's features, and of the ones this build iterates.
  featureOrder: string[]
  featureFids: string[]
  firstDirty: number
  globalRepo: Repository
  partStore: Record<string, PartSolid>
  result: BuildResponse['result']
  newCheckpoints: Record<string, FeatureCheckpoint>
  changes: PartChangeTracker
  registeredAtCheckpoint: Map<string, Map<string, string>>
  extractMetaCached: MetaExtractor
}

/** The post-loop pass: final render, checkpoint registration and meshes, the
 *  pick world, and the response. A stopped build never reaches it. */
function finishBuild(loop: LoopOutcome): BuildResponse {
  const {
    spec, options, deps, t0, featureOrder, featureFids, firstDirty,
    globalRepo, partStore, result, newCheckpoints, changes, registeredAtCheckpoint,
    extractMetaCached,
  } = loop
  const activeFids = new Set(featureOrder)
  globalRepo.gc(activeFids)

  // Clean prefix: checkpoints carried over verbatim from prevState (indices
  // < firstDirty). On a fully-clean rebuild (firstDirty === featureFids.length)
  // every checkpoint is a clean-prefix carry-over, including the last one.
  const cleanPrefixFids = new Set<string>()
  if (options.prevState && firstDirty > 0) {
    for (const fid of options.prevState.feature_order.slice(0, firstDirty)) {
      cleanPrefixFids.add(fid)
    }
  }

  // The final feature's checkpoint owns the one render mesh we always keep (for
  // display + an end-of-stack pick). Every earlier checkpoint stays lazy: its
  // bodies_snapshot is empty and the pick path meshes it on demand, keeping the
  // last pick world it meshed (`boundCheckpointMeshes`).
  const lastFid = featureFids.length ? featureFids[featureFids.length - 1] : null

  // Reuse the previous build's mesh for every body the tail left unchanged
  // (the whole final mesh on a fully-clean rebuild) and tessellate the rest.
  const finalRender = renderFinalParts({
    prevState: options.prevState,
    featureFids,
    firstDirty,
    partStore,
    tracker: changes,
    tessellate: (store) => deps.tessellateParts(store, globalRepo),
  })
  const partsOut = finalRender.parts
  if (options.verifyMeshReuse) {
    verifyReusedMeshes('final', partsOut, finalRender.reused, partStore,
      (store) => deps.tessellateParts(store, globalRepo))
  }

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
  // back to tessellateParts.
  for (const fid of Object.keys(newCheckpoints)) {
    if (cleanPrefixFids.has(fid)) continue
    const checkpoint = newCheckpoints[fid]
    const isLast = fid === lastFid
    const needing = partsNeedingCheckpointRegistration(
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
        ? partsOut
        : extractMetaCached(pickPartsById(checkpoint.body_store_snapshot, needing), null)
    } catch (e) {
      if (isKernelTrap(e)) throw e
      cpMeta = {}
    }
    const partsSnapshot = isLast
      ? Object.fromEntries(
          Object.keys(checkpoint.body_store_snapshot).map((bid) => [bid, partsOut[bid] ?? {}]),
        )
      : {}
    newCheckpoints[fid] = {
      spec: checkpoint.spec,
      result: checkpoint.result,
      repo_snapshot: snapshotWithBrepGeometry(checkpoint, cpMeta, needing),
      body_store_snapshot: checkpoint.body_store_snapshot,
      bodies_snapshot: partsSnapshot,
      ...(isLast ? { mesh_stable_since: finalRender.stableSince } : {}),
    }
  }

  // A fully-clean rebuild carries the final checkpoint over verbatim. It still
  // has to end up with this build's mesh and provenance: a rollback can make a
  // mesh-free checkpoint the final one.
  if (lastFid != null && cleanPrefixFids.has(lastFid)) {
    const cp = newCheckpoints[lastFid]
    if (!(finalRender.wholeReuse && cp.mesh_stable_since)) {
      newCheckpoints[lastFid] = {
        ...cp,
        bodies_snapshot: Object.fromEntries(
          Object.keys(cp.body_store_snapshot).map((bid) => [bid, partsOut[bid] ?? {}]),
        ),
        mesh_stable_since: finalRender.stableSince,
      }
    }
  }

  const buildMs = Math.round((performance.now() - t0) * 10) / 10

  const newState: BuildState = {
    feature_order: [...featureOrder],
    checkpoints: newCheckpoints,
  }

  // The pick world (the bodies before the edited feature). A checkpoint that
  // already carries a mesh serves it directly: the final one, or the pick
  // world an earlier solve stored on a checkpoint this build carried over
  // (a re-solved checkpoint is a new, mesh-free object). Otherwise a body the
  // final render proves unchanged since this boundary takes its final mesh, the
  // rest is tessellated, and the result is stored on the checkpoint so the next
  // solve with the editor still open does no OCC work for it.
  let pickPartsOut: Record<string, unknown> | undefined
  let pickTargetFid: string | null = null
  const pickBoundary = options.pickBoundary
  if (pickBoundary != null && pickBoundary >= 0 && pickBoundary <= featureFids.length) {
    if (pickBoundary === 0) {
      // Boundary 0 edits the first feature: the "before" state is the empty
      // doc, there is nothing to pick against. Carry {} so the main thread
      // still enters the 'editing' world (empty pick bodies) like any other
      // boundary, matching the unavailable-checkpoint contract below.
      pickPartsOut = {}
    } else {
      const targetFid = featureFids[pickBoundary - 1]
      const pickCheckpoint = newCheckpoints[targetFid] ?? options.prevState?.checkpoints[targetFid]
      if (pickCheckpoint) {
        pickTargetFid = targetFid
        const snap = pickCheckpoint.bodies_snapshot as Record<string, Record<string, unknown>>
        const pickStore = pickCheckpoint.body_store_snapshot
        if (Object.keys(snap).length) {
          pickPartsOut = snap
          // The final checkpoint's mesh is this build's render, verified above.
          if (options.verifyMeshReuse && targetFid !== lastFid) {
            const served = new Set(Object.keys(snap).filter((bid) => Object.keys(snap[bid] ?? {}).length))
            verifyReusedMeshes('pick', snap, served, pickStore, (store) => deps.tessellateParts(store, null))
          }
        } else {
          const pick = renderPickParts({
            pickStore,
            final: finalRender,
            fidIndex: new Map(featureFids.map((fid, i) => [fid, i])),
            boundaryIndex: pickBoundary - 1,
            tessellate: (store) => deps.tessellateParts(store, null),
          })
          pickPartsOut = pick.parts
          if (options.verifyMeshReuse) {
            verifyReusedMeshes('pick', pick.parts, pick.reused, pickStore, (store) => deps.tessellateParts(store, null))
          }
          if (targetFid in newCheckpoints && Object.keys(pick.parts).length) {
            newCheckpoints[targetFid] = { ...newCheckpoints[targetFid], bodies_snapshot: pick.parts }
          }
        }
      } else {
        // Checkpoint not found (e.g. prevState was null on first solve, or the
        // checkpoint was evicted between solves). Return empty so the caller
        // clears stale pick_bodies state instead of silently keeping it.
        pickPartsOut = {}
      }
    }
  }
  boundCheckpointMeshes(newCheckpoints, lastFid, pickTargetFid)

  // Builtin planes are always addressable in the result.
  Object.assign(result, BUILTIN_PLANE_RESULTS)

  // A later feature can make an earlier "also touches" warning no longer true.
  // Resolve against the final stack before the result crosses the boundary; the
  // checkpoints keep each feature's own unresolved row.
  resolveTouchWarnings(newState.feature_order, newCheckpoints, result)

  const response: BuildResponse = {
    solve_ms: buildMs,
    result,
    bodies: partsOut,
    _build_state: newState,
    ...(pickPartsOut ? { pick_bodies: pickPartsOut } : {}),
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

  // The build is over: a heartbeat from a later direct kernel call must not
  // name a feature this build already finished.
  clearFeatureProgress()
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
  registerPartBrepFromMeta,
  partVersion,
  partsNeedingCheckpointRegistration,
} from './builderAncestry'

// ─── TS kernel router ───
//
// The solver registry provides the per-doc solvability gate: a kind-set
// membership check that dispatches a doc to the TS/WASM leaf solvers when
// every feature kind is ported, else the doc cannot be solved at all.
// The gate is re-exported here so the solver hook reaches it through the
// builder, the same module that owns the solve entry points.
export { isDocFullyPorted, unportedKinds } from './solverRegistry'
