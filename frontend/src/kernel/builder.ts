// Orchestrates the feature-stack solve loop with dirty detection, checkpoint cache, and
// incremental rebuild. Feature solvers are injected via a registry, so this module stays
// testable with mock solvers.

import { sha256Hex } from './sha256'
import { extractErrorMessage } from './errors'
import {
  Repository,
  evictAncestryAndRegister,
  clearBodyAncestry,
  clearConsumedBodyAncestry,
  emitWire,
  absolute,
  canonical,
  ref,
  setCurrentFeatureId,
} from './query'
import { faceGeometryHash, edgeGeometryHash, vertexGeometryHash } from './geomHash'
import { BUILTIN_PLANE_RESULTS } from './solverConstants'
import { normalToFrame } from './types3d'
import type { Body, FeatureCheckpoint, BuildState } from './types3d'
import type { TessMesh } from './occ/tessellation'

// ─── Types ───

export interface FeatureResult {
  [key: string]: unknown
  status?: string
  solve_ms?: number
}

export type FeatureSolver = (
  feature: Record<string, unknown>,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
  featuresById: Record<string, Record<string, unknown>>,
  variableContext?: Record<string, number>,
) => FeatureResult

export interface BuildDeps {
  // Solve a single feature. Called by the orchestration loop.
  trySolveFeature: FeatureSolver
  // Register solved geometry / topology into the repo after a feature solves.
  postRegister: (
    repo: Repository,
    featureId: string,
    feature: Record<string, unknown>,
    result: FeatureResult,
  ) => void
  // Create a fresh global repository.
  initGlobalRepo: () => Repository
  // Tessellate all bodies in the store (triangles for rendering).
  tessellateBodies: (
    bodyStore: Record<string, Body>,
    repo: Repository | null,
  ) => Record<string, Record<string, unknown>>
  /** Mesh-free B-rep identification (face_data/face_queries + edges/vertices and
   *  their queries) used by the in-loop ancestry registration, so "tessellation
   *  is for eyes only": the feature loop never triangulates to identify entities.
   *  Returns the same shape as ``tessellateBodies`` (a ``mesh`` with empty
   *  geometry arrays but populated ``face_data``). Optional -- when omitted (pure
   *  non-OCC tests) registration falls back to ``tessellateBodies``. */
  extractBrepMetadata?: (
    bodyStore: Record<string, Body>,
    repo: Repository | null,
  ) => Record<string, Record<string, unknown>>
  // Optional: normalize legacy projected_* entity kinds. Defaults to identity.
  normalizeProjectedEntities?: (f: Record<string, unknown>) => Record<string, unknown>
  /** Compute face geometry hashes for brep_diff.new_faces. Called per-body
   *  inside the feature loop / checkpoint assembly while OCC handles are live,
   *  so the downstream ``face_created_by`` tag correctly distinguishes new faces
   *  (attributed to the modifying feature) from inherited faces (original
   *  creator). When omitted, all faces get ``body.created_by``. */
  brepDiffNewFaceHashes?: (body: Body) => Set<string>
  /** Compute edge geometry hashes for brep_diff.new_edges. Same contract as
   *  ``brepDiffNewFaceHashes`` but for edge ancestry. */
  brepDiffNewEdgeHashes?: (body: Body) => Set<string>
  /** Compute vertex geometry hashes for purely-new vertices (endpoints of new
   *  edges minus endpoints of inherited edges). Same contract. */
  brepDiffNewVertexHashes?: (body: Body) => Set<string>
  /** Retain a checkpoint's live shape under an owner tag so a later feature in
   *  the same build that consumes/frees that shape cannot strand the snapshot,
   *  and the shape survives into the next build for incremental restore. A pure
   *  refcount bump -- it never touches the OCC shape, so it cannot disturb a
   *  downstream maker operating on the same handle (copying it here does). */
  retainCheckpointShape?: (shape: NonNullable<Body['shape']>, owner: string) => void
  /** Defensive copy of a (pristine, prev-build) checkpoint shape into a fresh
   *  handle, used only when restoring the clean prefix: the rebuilt tail may
   *  consume/free it, so it must be independent of the retained checkpoint copy
   *  that future rebuilds restore from again. When omitted (pure non-OCC tests)
   *  the handle is aliased. The copy is registered under ``owner`` (the per-
   *  build [[RESTORE_OWNER]] tag) so the next build's ``releaseRestoreCopies``
   *  can free it once the live store has replaced it -- an untagged copy would
   *  strand forever, invisible to every ``releaseOwner``. */
  copyBodyShape?: (
    shape: NonNullable<Body['shape']>,
    owner?: string,
  ) => NonNullable<Body['shape']>
  /** Evict every shape a discarded checkpoint held, by owner tag. Called for
   *  prev-state checkpoints that a new build discards. The wiring must drop
   *  BOTH remaining owners of the outgoing generation: the checkpoint retain
   *  (``'cp:' + fid``) and the base body registration (owner = the PRODUCING
   *  feature id -- bodySplit tags new bodies and replacements alike with the
   *  feature that minted them). The retain alone leaves rc>=1 on every
   *  superseded shape; for a modifier edit the leftover ref sits under a
   *  still-clean creator and strands one solid per edit. */
  releaseCheckpoint?: (fid: string) => void
  /** Release the previous build's clean-prefix restore copies (owner tag
   *  [[RESTORE_OWNER]]). Called right before the restore mints fresh ones, so
   *  exactly one generation of copies is ever alive; copies a surviving clean
   *  checkpoint retained stay at its ``cp:*`` reference until that checkpoint
   *  is itself evicted. */
  releaseRestoreCopies?: () => void
  /** Deps bound to a THROWAWAY scope + HandleTable plus its ``dispose()``,
   *  used for the second full build behind ``spec._validate``. That comparison
   *  build discards its BuildState when validation ends, so handed the
   *  caller's deps it pins every inner shape in the persistent cache under
   *  ``<fid>`` / ``'cp:'+fid`` owners that no later eviction can ever name --
   *  one stranded solid generation per validated solve. Fresh wiring here
   *  contains the inner generation completely: ``dispose()`` drops scope and
   *  table wholesale once the diff is computed. When omitted (pure non-OCC
   *  tests) validation runs on the caller's own deps. */
  isolatedValidationDeps?: () => { deps: BuildDeps; dispose: () => void }
}

export interface BuildOptions {
  prevState?: BuildState | null
  pickBoundary?: number | null
  rollbackPosition?: number | null
}

export interface BuildResponse {
  solve_ms: number
  result: Record<string, unknown>
  bodies: Record<string, unknown>
  // The worker owns `_build_state` (checkpoint cache) and mutates it between
  // solves; main-thread consumers must treat it as read-only. The solver-client
  // stub that satisfies this field is deeply frozen.
  _build_state: Readonly<BuildState>
  pick_bodies?: Record<string, unknown>
  _validation?: RebuildValidation
}

export interface RebuildValidation {
  level: 1 | 2 | 3
  passed: boolean
  fp_only?: boolean
  diffs: Record<string, unknown>
}

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

// ─── Shape / body snapshot helpers ───

/**
 * Owner tag under which every clean-prefix restore copy of one build is
 * registered. Released (``releaseRestoreCopies``) right before the next build
 * overwrites the live store with fresh copies, so the deep ``copyBodyShape``
 * copies cannot accumulate one per body per incremental solve. The tag cannot
 * collide with a feature id (base64url), so it can never match a ``cp:*`` or
 * created-by owner.
 */
export const RESTORE_OWNER = 'restore'

// ``mapShape``, when provided, transforms the body's shape handle for the
// snapshot: retain-in-place at checkpoint time, defensive-copy at restore time.
// Without it the handle is aliased (non-OCC tests).
type ShapeMapper = (shape: NonNullable<Body['shape']>) => NonNullable<Body['shape']>

// Mesh-free B-rep metadata for a set of bodies: the shape of both
// ``BuildDeps.extractBrepMetadata`` and the build-scoped memoised wrapper the
// solve loop and the checkpoint pass share.
type MetaExtractor = (
  bodyStore: Record<string, Body>,
  repo: Repository | null,
) => Record<string, Record<string, unknown>>

function _copyBody(body: Body, mapShape?: ShapeMapper): Body {
  return {
    id: body.id,
    created_by: body.created_by,
    modified_by: [...body.modified_by],
    shape: (body.shape != null && mapShape) ? mapShape(body.shape) : body.shape,
    sketch_id: body.sketch_id,
    brep_diff: body.brep_diff,
    profile_queries: [...body.profile_queries],
    ...(body.face_names ? { face_names: { ...body.face_names } } : {}),
    ...(body.edge_names ? { edge_names: { ...body.edge_names } } : {}),
    ...(body.face_ancestry ? { face_ancestry: { ...body.face_ancestry } } : {}),
    ...(body.edge_ancestry ? { edge_ancestry: { ...body.edge_ancestry } } : {}),
    ...(body.imported ? { imported: true } : {}),
  }
}

/** The persisted repo shape. Exported for the shape guard in `ancestryIndex.test.ts`,
 *  which freezes this THREE-KEY SET: the derived indices must never leak in here,
 *  `repoFromSnapshot` rebuilds them. Nothing hashes the canonical key strings
 *  themselves, so their byte format stays free to change. */
export function snapshotRepo(repo: Repository): Record<string, unknown> {
  return {
    elements: Object.fromEntries(repo.elements),
    ancestral: Object.fromEntries(
      [...repo.ancestral.entries()].map(([k, v]) => [k, { set: [...v.set], eids: [...v.eids] }])
    ),
    byUuid: Object.fromEntries(
      [...repo.byUuid.entries()].map(([k, v]) => [k, [...v]])
    ),
  }
}

function _pickBodies(bodyStore: Record<string, Body>, ids: ReadonlySet<string>): Record<string, Body> {
  return Object.fromEntries(Object.entries(bodyStore).filter(([bid]) => ids.has(bid)))
}

function _snapshotBodies(
  bodyStore: Record<string, Body>,
  mapShape?: ShapeMapper,
): Record<string, Body> {
  return Object.fromEntries(
    Object.entries(bodyStore).map(([k, v]) => [k, _copyBody(v, mapShape)]),
  )
}

function _dedupeRepo(repo: Repository): void {
  for (const [key, entry] of [...repo.ancestral.entries()]) {
    const uniqueIds: string[] = []
    const seen = new Set<string>()
    for (const elementId of entry.eids) {
      const payload = repo.elements.get(elementId)
      if (payload === undefined) continue
      // The payload-equality predicate shared with the live dedup-skip and the
      // parity fingerprint (`stableJson`, see its doc comment; the structural
      // `payloadEqual` in postRegister.ts is the other, stricter one):
      // recursive stable JSON, so nested object content is hashed. The old
      // allowlist serializer (`Object.keys(payload).sort()`) is a per-level
      // property allowlist, not a key sorter, so nested objects always
      // serialized to `{}` and two payloads differing only in nested content
      // were wrongly merged.
      const payloadHash = stableJson(payload)
      if (seen.has(payloadHash)) {
        repo.deleteElement(elementId)
        continue
      }
      seen.add(payloadHash)
      uniqueIds.push(elementId)
    }
    if (uniqueIds.length) {
      entry.eids = uniqueIds
    } else {
      repo.deleteAncestral(key)
    }
  }
  // A deleted duplicate can empty a uuid bucket outright (it carried its own
  // uuid); prune now so a restore never leaves a dead bucket behind.
  repo.prunePendingUuids()
}

export function repoFromSnapshot(repoSnapshot: Record<string, unknown>): Repository {
  const repo = new Repository()
  if (repoSnapshot.elements || repoSnapshot.ancestral) {
    repo.elements = new Map(Object.entries(repoSnapshot.elements as Record<string, unknown>))
    repo.ancestral = new Map(
      Object.entries(repoSnapshot.ancestral as Record<string, { set: string[]; eids: string[] }>).map(
        ([k, v]) => [k, { set: new Set(v.set), eids: [...v.eids] }]
      )
    )
    repo.byUuid = new Map(
      Object.entries((repoSnapshot.byUuid as Record<string, string[]>) ?? {}).map(([k, v]) => [k, [...v]])
    )
    repo.rebuildIndices()  // the maps were replaced wholesale, so the derived indices are stale
  }
  _dedupeRepo(repo)
  return repo
}

// ─── Hash / validation helpers ───

// The canonical payload-equality predicate for the restore dedupe (`_dedupeRepo`),
// the live dedup-skip (`_registerBrepFaceAncestry`) and the parity fingerprint
// (`repoFingerprintTestUtil`). Stable under object key order (recursive key sort)
// and Map entry order (Maps become sorted-key objects), and normalizes `-0` to
// `0`. It does NOT hash every content difference: JSON.stringify drops
// undefined-valued object keys (`{a:1,b:undefined}` hashes like `{a:1}`) and
// serializes undefined array elements and NaN in arrays and object values as
// `null`, so `[1,undefined]` collides with `[1,null]` and `{a:NaN}` with
// `{a:null}`; a Map also collides with a plain object carrying the same entries.
// Equal hashes are therefore a coarser equality than content identity: only
// payloads that really differ as JSON-clean JSON are guaranteed to hash
// differently. The collisions are pre-existing and shared by the three uses
// above, so they can never diverge live vs restored, but a future payload that
// accidentally carries an undefined or NaN value will silently merge distinct
// elements. It is NOT the only payload-equality predicate in the codebase:
// `registerAncestralDeduped` (postRegister.ts) dedupes with a structural
// `payloadEqual` that keeps undefined-valued object keys, so the two predicates
// disagree exactly on a payload carrying one (here it merges with the key-less
// twin, there it stays distinct). No current payload carries an undefined key, so
// the divergence is latent; a future one will behave differently in the two
// dedupes.
export function stableJson(obj: unknown): string {
  return JSON.stringify(obj, (_k, v) => {
    if (v instanceof Map) {
      const entries = [...v.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      return Object.fromEntries(entries)
    }
    if (typeof v === 'number' && Object.is(v, -0)) return 0
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {}
      for (const key of Object.keys(v).sort()) sorted[key] = (v as Record<string, unknown>)[key]
      return sorted
    }
    return v
  })
}

function _roundFloats(obj: unknown, ndigits: number): unknown {
  if (typeof obj === 'number') {
    const r = Number(obj.toFixed(ndigits))
    return Object.is(r, -0) ? 0 : r
  }
  if (Array.isArray(obj)) return obj.map((v) => _roundFloats(v, ndigits))
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) out[k] = _roundFloats(v, ndigits)
    return out
  }
  return obj
}

const RESULT_NON_GEOMETRIC_KEYS = new Set(['solve_ms'])

function _stripNonGeometric(obj: unknown): unknown {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (!RESULT_NON_GEOMETRIC_KEYS.has(k)) out[k] = _stripNonGeometric(v)
    }
    return out
  }
  if (Array.isArray(obj)) return obj.map(_stripNonGeometric)
  return obj
}

export function hashCheckpointSpec(cp: FeatureCheckpoint): string {
  return sha256Hex(stableJson(cp.spec))
}

export function hashResultDict(result: Record<string, unknown>, fpRound?: number | null): string {
  let payload = _stripNonGeometric(result)
  if (fpRound != null) payload = _roundFloats(payload, fpRound)
  return sha256Hex(stableJson(payload))
}

function _diffRepoSnapshot(
  a: BuildState,
  b: BuildState,
  featureIdx?: number | null,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {}
  if (JSON.stringify(a.feature_order) !== JSON.stringify(b.feature_order)) {
    diff['feature_order'] = { a: a.feature_order, b: b.feature_order }
  }
  const fids = featureIdx != null ? [a.feature_order[featureIdx]] : a.feature_order
  for (const fid of fids) {
    const cpA = a.checkpoints[fid]
    const cpB = b.checkpoints[fid]
    if (!cpA || !cpB) {
      const arr = (diff['missing_checkpoints'] ??= []) as unknown[]
      arr.push(fid)
      continue
    }
    const aBodies = Object.fromEntries(
      Object.entries(cpA.body_store_snapshot).map(([bid, body]) => [
        bid,
        { created_by: body.created_by, modified_by: [...body.modified_by] },
      ])
    )
    const bBodies = Object.fromEntries(
      Object.entries(cpB.body_store_snapshot).map(([bid, body]) => [
        bid,
        { created_by: body.created_by, modified_by: [...body.modified_by] },
      ])
    )
    if (JSON.stringify(aBodies) !== JSON.stringify(bBodies)) {
      const store = (diff['body_store'] ??= {}) as Record<string, unknown>
      store[fid] = { a: aBodies, b: bBodies }
    }
    const aRepo = cpA.repo_snapshot as Record<string, unknown>
    const bRepo = cpB.repo_snapshot as Record<string, unknown>
    const aAncestral = aRepo.ancestral as Record<string, unknown> | undefined
    const bAncestral = bRepo.ancestral as Record<string, unknown> | undefined
    const aKeys = new Set(aAncestral ? Object.keys(aAncestral) : [])
    const bKeys = new Set(bAncestral ? Object.keys(bAncestral) : [])
    const added = [...bKeys].filter((k) => !aKeys.has(k)).sort()
    const removed = [...aKeys].filter((k) => !bKeys.has(k)).sort()
    if (added.length || removed.length) {
      const ra = (diff['repo_ancestral'] ??= {}) as Record<string, unknown>
      ra[fid] = {
        added: added.slice(0, 20),
        removed: removed.slice(0, 20),
        added_total: added.length,
        removed_total: removed.length,
      }
    }
  }
  return diff
}

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
    return { level: 3, passed: false, diffs: _diffRepoSnapshot(incrementalState, freshState) }
  }

  // L3 final guard.
  const l3 = _diffRepoSnapshot(incrementalState, freshState)
  if (Object.keys(l3).length) {
    return { level: 3, passed: false, diffs: l3 }
  }
  return { level: 3, passed: true, diffs: {} }
}

// ─── B-rep diff hash helpers ───

function _brepDiffNewFaceHashes(body: Body, deps?: BuildDeps): Set<string> {
  if (deps?.brepDiffNewFaceHashes) return deps.brepDiffNewFaceHashes(body)
  return new Set()
}

function _brepDiffNewEdgeHashes(body: Body, deps?: BuildDeps): Set<string> {
  if (deps?.brepDiffNewEdgeHashes) return deps.brepDiffNewEdgeHashes(body)
  return new Set()
}

function _brepDiffNewVertexHashes(body: Body, deps?: BuildDeps): Set<string> {
  if (deps?.brepDiffNewVertexHashes) return deps.brepDiffNewVertexHashes(body)
  return new Set()
}

// ─── Ancestry registration ───

function _registerBrepFaceAncestry(globalRepo: Repository, body: Body, mesh: TessMesh, deps?: BuildDeps): void {
  if (!body.created_by || !mesh.face_data) return
  const newFaceHashes = _brepDiffNewFaceHashes(body, deps)
  for (let faceIdx = 0; faceIdx < mesh.face_data.length; faceIdx++) {
    const faceInfo = mesh.face_data[faceIdx]
    const centroid = faceInfo.centroid
    const normal = faceInfo.normal
    const geomHash = faceGeometryHash(centroid, normal)
    let faceCreatedBy = body.created_by
    if (newFaceHashes.size && newFaceHashes.has(geomHash) && body.modified_by.length) {
      faceCreatedBy = body.modified_by[body.modified_by.length - 1]
    }
    const ancestorIds = [
      emitWire(absolute(body.id, `face${faceIdx}`)),
      emitWire(absolute(faceCreatedBy)),
      emitWire(absolute(body.id)),
    ]
    const uuid = body.face_names?.[geomHash] ?? null
    const ancestryTokens = (uuid && body.face_ancestry) ? (body.face_ancestry[uuid] ?? null) : null
    if (ancestryTokens && ancestryTokens.length) {
      ancestorIds.push(...ancestryTokens)
    } else if (body.profile_queries.length) {
      ancestorIds.push(...body.profile_queries)
    }
    const { x_axis, y_axis } = normalToFrame(normal)
    const axis = faceInfo.axis ?? undefined
    const payload = {
      type: faceInfo.surface_type ?? 'face',
      body_id: body.id,
      created_by: faceCreatedBy,
      face_index: faceIdx,
      centroid,
      normal,
      origin: centroid,
      x_axis,
      y_axis,
      classifiers: faceInfo.classifiers ?? [],
      ...(uuid !== null ? { uuid } : {}),
      ...(axis ? { axis } : {}),
    }
    const key = canonical(ancestorIds)
    const entry = globalRepo.ancestral.get(key)
    const existingIds = entry ? entry.eids : []
    // Hoist the payload serialization out of the dedup scan: the entry can hold
    // many elements, and recomputing stableJson(payload) per comparison is the
    // O(n) repeat the edge/vertex paths already avoid.
    const payloadJson = stableJson(payload)
    if (existingIds.some((eid) => stableJson(globalRepo.elements.get(eid)) === payloadJson)) {
      continue
    }
    const indexTag = emitWire(absolute(body.id, `face${faceIdx}`))
    evictAncestryAndRegister(globalRepo, ancestorIds, payload, indexTag, uuid)
  }
}

/**
 * The repository payload registered for one B-rep edge. Carries every geometric
 * field a consumer (projection lowering, measurements) might read: circle/arc
 * use `radius`, ellipse needs `a`/`b` (semi-axes) -- omitting those makes a
 * resolved elliptical edge unprojectable (resolve3dGeometry returns null).
 */
export function edgeAncestryPayload(
  edge: Record<string, unknown>,
  bodyId: string,
  edgeCreatedBy: string,
  idx: number,
): Record<string, unknown> {
  return {
    type: edge.kind === 'line' ? 'straightedge' : 'edge',
    body_id: bodyId,
    created_by: edgeCreatedBy,
    edge_index: idx,
    kind: edge.kind,
    start: edge.start,
    end: edge.end,
    center: edge.center,
    radius: edge.radius,
    a: edge.a,
    b: edge.b,
    axis: edge.axis,
    x_axis: edge.x_axis,
    angle_start: edge.angle_start,
    angle_end: edge.angle_end,
    classifiers: (edge.classifiers as string[]) ?? [],
  }
}

function _registerBrepEdgeAncestry(
  globalRepo: Repository,
  body: Body,
  edges: Array<Record<string, unknown>>,
  edgeQueries: string[],
  deps?: BuildDeps,
): void {
  if (!body.created_by || !edgeQueries.length) return
  const newEdgeHashes = _brepDiffNewEdgeHashes(body, deps)
  for (let idx = 0; idx < edges.length && idx < edgeQueries.length; idx++) {
    const edge = edges[idx]
    const geomHash = edgeGeometryHash(edge)
    let edgeCreatedBy = body.created_by
    if (newEdgeHashes.size && newEdgeHashes.has(geomHash) && body.modified_by.length) {
      edgeCreatedBy = body.modified_by[body.modified_by.length - 1]
    }
    const ancestorIds = [
      emitWire(absolute(body.id, `edge${idx}`)),
      emitWire(absolute(edgeCreatedBy)),
      emitWire(absolute(body.id)),
    ]
    const uuid = body.edge_names?.[geomHash] ?? null
    const ancestryTokens = (uuid && body.edge_ancestry) ? (body.edge_ancestry[uuid] ?? null) : null
    if (ancestryTokens && ancestryTokens.length) {
      ancestorIds.push(...ancestryTokens)
    } else if (body.profile_queries.length) {
      ancestorIds.push(...body.profile_queries)
    }
    const payload = { ...edgeAncestryPayload(edge, body.id, edgeCreatedBy, idx), ...(uuid !== null ? { uuid } : {}) }
    const indexTag = emitWire(absolute(body.id, `edge${idx}`))
    evictAncestryAndRegister(globalRepo, ancestorIds, payload, indexTag, uuid)
  }
}

function _registerBrepVertexAncestry(
  globalRepo: Repository,
  body: Body,
  vertices: Array<number[]>,
  vertexQueries: string[],
  vertexUuids: Array<string | null>,
  deps?: BuildDeps,
): void {
  if (!body.created_by || !vertexQueries.length) return
  const newVertexHashes = _brepDiffNewVertexHashes(body, deps)
  for (let idx = 0; idx < vertices.length && idx < vertexQueries.length; idx++) {
    const pt = vertices[idx]
    const geomHash = vertexGeometryHash(pt)
    let vertexCreatedBy = body.created_by
    if (newVertexHashes.size && newVertexHashes.has(geomHash) && body.modified_by.length) {
      vertexCreatedBy = body.modified_by[body.modified_by.length - 1]
    }
    const ancestorIds = [
      emitWire(absolute(body.id, `vertex${idx}`)),
      emitWire(absolute(vertexCreatedBy)),
      emitWire(absolute(body.id)),
    ]
    if (body.profile_queries.length) ancestorIds.push(...body.profile_queries)
    const uuid = vertexUuids[idx] ?? null
    const payload = {
      type: 'vertex',
      body_id: body.id,
      created_by: vertexCreatedBy,
      vertex_index: idx,
      origin: pt,
      ...(uuid !== null ? { uuid } : {}),
    }
    const indexTag = emitWire(absolute(body.id, `vertex${idx}`))
    evictAncestryAndRegister(globalRepo, ancestorIds, payload, indexTag, uuid)
  }
}

// Keyed on the creating feature alone, so the N bodies of one feature all land
// under one ancestral key -- `registerAncestor` accumulates (query.ts), so the
// entry ends up holding N solid elements, each with its own `body_id` (the
// restore dedupe keeps them all; they are distinct payloads). Deliberate: a
// `:solid`-restricted query over a multi-body feature is ambiguous and fails
// loud. The ambiguity is NOT unobservable: `resolveBodyPickRef` lets a `?` pick
// through and it is persisted as `merge_target`/`source_body`, and at solve time
// `resolveBodyRefKeys` runs it through the repo query, catches the ambiguity,
// and falls back to reading the `@body_*` ancestor from the query. So an
// ambiguous `[@fid]` entry degrades a body pick to the query's body ancestor
// rather than to a wrong single solid. `_reconcileFeatureSolids` keeps the count
// equal to the live body store after every re-solve, so N is the number of
// bodies the feature owns right now.
function _registerSolidAncestry(globalRepo: Repository, body: Body): void {
  if (!body.created_by) return
  globalRepo.registerAncestor([ref(body.created_by)], {
    type: 'solid',
    body_id: body.id,
    created_by: body.created_by,
  })
}

// The payload carries no body id, so a feature owning N bodies registers one
// byte-identical `extrusion-feature` element per body. `registerAncestor`
// accumulates (query.ts), which would leave N identical elements live while the
// restore dedupe collapses them to 1 -- live and restored repos would disagree
// under `?@fid:extrusion-feature`. Skip the insert when an equal payload already
// sits in the entry (the SAME predicate the restore dedupe uses), so live holds
// exactly one and matches the restored repo.
function _registerExtrusionFeature(globalRepo: Repository, featureId: string, sketchId = ''): void {
  if (!featureId) return
  const payload = {
    type: 'extrusion-feature',
    feature_id: featureId,
    sketch_id: sketchId,
  }
  // The payload carries no body id, so every owned body compares against the SAME
  // target; hoist its hash once so N owned bodies cost N candidate hashes, not N x N.
  const payloadHash = stableJson(payload)
  const entry = globalRepo.ancestral.get(canonical([ref(featureId)]))
  if (entry?.eids.some((eid) => stableJson(globalRepo.elements.get(eid)) === payloadHash)) {
    return
  }
  globalRepo.registerAncestor([ref(featureId)], payload)
}

function isDict(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// Drop only the `solid`/`extrusion-feature` elements under `[@fid]`, keeping every
// other payload postRegister put there (e.g. the `sketch-feature` element). The wipe
// in `clearFeatureGeometryRegistrations` is deliberately left wholesale (option b):
// this evict plus the re-register below is what restores the solids a re-solve took
// out, and it is what stops the checkpoint pass from stacking a duplicate per body.
function _evictFeatureSolidAncestry(globalRepo: Repository, fid: string): void {
  const key = canonical([ref(fid)])
  const entry = globalRepo.ancestral.get(key)
  if (!entry) return
  const surviving: string[] = []
  for (const eid of entry.eids) {
    const payload = globalRepo.elements.get(eid)
    if (payload === undefined) continue  // already-dead eid: drop it, never ride the surviving list
    const type = isDict(payload) ? payload.type : null
    if (type === 'solid' || type === 'extrusion-feature') globalRepo.deleteElement(eid)
    else surviving.push(eid)
  }
  if (surviving.length) entry.eids = surviving
  else globalRepo.deleteAncestral(key)
  globalRepo.prunePendingUuids()
}

// Make the `[@fid]` solid/extrusion entries match the current bodyStore: every body
// the feature owns (`created_by === fid`) contributes exactly one `solid` and one
// `extrusion-feature` element. `registerAncestor` accumulates (query.ts), so the
// reconcile evicts the previous solid/extrusion elements first and re-registers --
// that is what makes it idempotent instead of stacking a duplicate per rebuild.
// Runs after the body loop (which re-registers solids only for bodies it just
// created), so a feature re-solved with a cosmetic edit keeps its solids for bodies
// the loop left alone.
function _reconcileFeatureSolids(
  globalRepo: Repository,
  fid: string,
  bodyStore: Record<string, Body>,
  shapeOwningFids?: ReadonlySet<string>,
): void {
  // Most features (sketches, planes, modifiers, ...) own no shaped body, so the
  // scan below would be pure waste per feature; both callers precompute who owns
  // one and hand it in, turning the common case into an O(1) exit. Safe to skip:
  // the loop is the only writer of solids under `[@fid]` and it only writes for
  // shaped owned bodies, so nothing to evict or register here either.
  if (shapeOwningFids && !shapeOwningFids.has(fid)) return
  _evictFeatureSolidAncestry(globalRepo, fid)
  for (const body of Object.values(bodyStore)) {
    if (body.created_by !== fid) continue
    if (body.shape == null) continue  // mirror the solve-loop guard at :1141:
    // reconcile registers only what the loop would
    _registerSolidAncestry(globalRepo, body)
    _registerExtrusionFeature(globalRepo, body.created_by || '', body.sketch_id)
  }
}

/**
 * Register one body's B-rep face/edge/vertex ancestry into `repo` from an
 * already-extracted geometry blob -- mesh-free metadata or a full render mesh, which
 * carry the same shape.
 *
 * The ONE registrar, shared by the in-loop pass and the post-loop checkpoint pass, so
 * "the loop already registered this body version" is a claim about identical work.
 * The two used to disagree on two points, both resolved here in favour of the loop:
 * a fallback mesh identifies no faces (there is no real B-rep behind it, so the
 * payloads would be fiction), and a missing `edge_queries`/`vertex_queries` list is
 * filled with length-matched placeholders rather than suppressing registration -- those
 * lists are presence/length gates in the registrars, their content is unused.
 */
function arrayOr<T>(value: unknown, fallback: T[] = []): T[] {
  return Array.isArray(value) ? (value as T[]) : fallback
}

export function registerBodyBrepFromMeta(
  repo: Repository,
  body: Body,
  meta: Record<string, unknown>,
  deps?: BuildDeps,
): void {
  // Replace the body's whole index range, old and shrunken tails included: the
  // index-tag eviction inside each registrar only touches the indices about to
  // be re-registered, so a body that comes back with fewer faces/edges/vertices
  // would otherwise leave k..N-1 resolvable forever (index-shrink-ghost-eviction).
  clearBodyAncestry(repo, body.id)
  const mesh = meta['mesh'] as TessMesh | undefined
  if (mesh && !mesh.is_fallback) _registerBrepFaceAncestry(repo, body, mesh, deps)
  // Non-array geometry is treated as absent rather than trusted: the checkpoint pass has
  // no exception guard (the solve loop's `_registerBodyFaces` does), so a deps wiring that
  // hands back the wrong shape would abort the whole build instead of costing one body
  // its ancestry. `arrayOr` keeps both callers on the loop's forgiving contract.
  const edges = arrayOr<Record<string, unknown>>(meta['edges'])
  const edgeQueries = arrayOr<string>(meta['edge_queries'], edges.map(() => ''))
  if (edges.length) _registerBrepEdgeAncestry(repo, body, edges, edgeQueries, deps)
  const verts = arrayOr<number[]>(meta['vertices'])
  const vertQueries = arrayOr<string>(meta['vertex_queries'], verts.map(() => ''))
  const vertUuids = arrayOr<string | null>(meta['vertex_uuids'])
  if (verts.length) _registerBrepVertexAncestry(repo, body, verts, vertQueries, vertUuids, deps)
}

// Read one body's B-rep and register its ancestry into the live repo. Called
// per feature in the build loop so a later feature's face/edge/vertex query
// resolves against an earlier body's geometry (e.g. a circular_array axis edge
// query).
//
// Returns whether the ancestry actually landed. Both failure exits are silent by design
// (a body that cannot be identified still solves, it just loses its ancestry), and the
// caller MUST NOT record such a body as registered: the checkpoint pass would then skip
// a body whose ancestry is in no snapshot at all. `extractBrepMetadata` fails exactly
// this way, per body, while `tessellateBodies` may still succeed for the same body --
// which is what gives the checkpoint pass something to recover from.
function _registerBodyFaces(
  globalRepo: Repository,
  body: Body,
  deps: BuildDeps,
  extractCached?: MetaExtractor,
): boolean {
  if (body.shape == null) return false
  try {
    // Identify off the B-rep alone (no triangulation); fall back to the mesh
    // path when no metadata extractor is wired (pure non-OCC tests).
    const extract = extractCached ?? deps.extractBrepMetadata ?? deps.tessellateBodies
    const out = extract({ [body.id]: body }, globalRepo)[body.id]
    if (!out) return false
    registerBodyBrepFromMeta(globalRepo, body, out, deps)
    return true
  } catch {
    // Non-fatal: a body that fails to identify just lacks B-rep ancestry, and
    // the build continues.
    return false
  }
}

/** A body's identity for the duration of ONE build: a feature that changes a body
 *  registers a fresh shape handle and appends to `modified_by`, so this changes with
 *  it. Valid only within a build -- the clean-prefix restore mints new handles every
 *  solve -- which is all its two users (the metadata cache and the checkpoint
 *  registration skip) need.
 *
 *  The blind spot, since both users are cache keys: a solver that rewrote a body's
 *  `face_names` / `face_ancestry` / `edge_names` / `edge_ancestry` / `profile_queries`
 *  WITHOUT minting a shape handle and WITHOUT appending to `modified_by` would produce
 *  the same string for different ancestry. No solver does today -- every name-map write
 *  in `features/` is paired with `resplitBody` (which always registers a fresh handle;
 *  `HandleTable.register` never recycles ids) or a `modified_by` push -- but a name-map
 *  write that lands and is then followed by a THROWN `resplitBody` reaches exactly that
 *  state. The feature reports an exception in that case, so it is not silent. */
export function bodyVersion(b: Body): string {
  return `${b.id}|${b.created_by}|${String(b.shape)}|${b.modified_by.length}`
}

/**
 * Which bodies of a checkpoint's body-store snapshot the post-loop registration pass
 * still has to register.
 *
 * The feature loop registers a body's B-rep ancestry into the LIVE repo, and the
 * checkpoint's `repo_snapshot` is taken after that -- so the snapshot the post-loop pass
 * rehydrates already contains the ancestry for every body version the loop registered.
 * Re-registering it is pure cost: identical face payloads hit the skip guard in
 * `_registerBrepFaceAncestry` (after a `stableJson` per candidate AND per existing
 * element), while edges and vertices churn through `evictAncestryAndRegister` and mint
 * fresh eids for the same payloads.
 *
 * `registeredVersions` maps body id -> the version whose ancestry actually landed in the
 * repo this checkpoint was snapshotted from. A body is missing from it when the loop
 * never registered it (a null-shape body) or when its registration silently failed to
 * land (`_registerBodyFaces` returned false), so it still needs the pass -- the
 * checkpoint pass reads a different producer and may well succeed where the loop's did
 * not.
 */
export function bodiesNeedingCheckpointRegistration(
  bodyStoreSnapshot: Record<string, Body>,
  registeredVersions: ReadonlyMap<string, string>,
): Set<string> {
  const out = new Set<string>()
  for (const [bodyId, body] of Object.entries(bodyStoreSnapshot)) {
    if (registeredVersions.get(bodyId) !== bodyVersion(body)) out.add(bodyId)
  }
  return out
}

// `needing` names the bodies whose ancestry the checkpoint's snapshot does NOT already
// carry (see `bodiesNeedingCheckpointRegistration`); undefined means "register every
// body", the pre-skip behaviour.
function _snapshotWithBrepGeometry(
  checkpoint: FeatureCheckpoint,
  bodiesOut: Record<string, Record<string, unknown>>,
  deps?: BuildDeps,
  needing?: ReadonlySet<string>,
): Record<string, unknown> {
  const repo = repoFromSnapshot(checkpoint.repo_snapshot as Record<string, unknown>)
  const ownedFids = new Set<string>()
  const shapeOwningFids = new Set<string>()
  for (const [bodyId, body] of Object.entries(checkpoint.body_store_snapshot)) {
    // Skip what the feature loop already registered into the very snapshot being
    // rehydrated here: `needing` is empty for a body whose version has not moved since
    // the loop registered it, and its ancestry is therefore already in the snapshot.
    if (needing && !needing.has(bodyId)) continue
    registerBodyBrepFromMeta(repo, body, bodiesOut[bodyId] ?? {}, deps)
    if (body.created_by) {
      ownedFids.add(body.created_by)
      // A needing body is shaped (the loop only attempts shaped bodies), so the
      // fids that matter for the solid reconcile are exactly these.
      if (body.shape != null) shapeOwningFids.add(body.created_by)
    }
  }
  // Reconcile solids per owning feature exactly like the solve loop: the bodies above
  // can include one the loop could NOT register (needing), whose solid the per-body
  // append would otherwise stack onto the solid the loop already wrote --
  // `registerAncestor` accumulates, so `[@fid]` would end up with two identical
  // solids. Evict-then-register keeps the checkpoint matching the body store.
  for (const fid of ownedFids) _reconcileFeatureSolids(repo, fid, checkpoint.body_store_snapshot, shapeOwningFids)
  // One serializer, so the "derived indices never reach the persisted shape"
  // guard on snapshotRepo covers this path too.
  return { version: 2, ...snapshotRepo(repo) }
}

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
  // twice over: once per feature in the solve loop (`_registerBodyFaces`) and
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
        _snapshotBodies(
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

  // Fids that own at least one shaped body, so `_reconcileFeatureSolids` can exit in
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
      const cpSnapshot = _snapshotBodies(bodyStore, retainForCheckpoint(fid))
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
        const landed = _registerBodyFaces(globalRepo, body, deps, extractMetaCached)
        _registerSolidAncestry(globalRepo, body)
        _registerExtrusionFeature(globalRepo, body.created_by || '', body.sketch_id)
        registeredBodyIds.add(bodyId)
        if (landed) registeredVersions.set(bodyId, bodyVersion(body))
      } else if (body.shape != null && body.modified_by.length > (before[bodyId]?.modifiedByLen ?? 0)) {
        // Body was modified; re-register faces so downstream features see updates. A
        // failed re-registration must also drop the stale entry: the snapshot now holds
        // the PREVIOUS version's ancestry, which is not what this checkpoint carries.
        if (_registerBodyFaces(globalRepo, body, deps, extractMetaCached)) {
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
    _reconcileFeatureSolids(globalRepo, fid, bodyStore, shapeOwningFids)

    const cpSnapshot = _snapshotBodies(bodyStore, retainForCheckpoint(fid))
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
  // re-registering it only churned eids and burned `stableJson` per face per checkpoint.
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
    const cpMeta = isLast
      ? bodiesOut
      : extractMetaCached(_pickBodies(checkpoint.body_store_snapshot, needing), null)
    const bodiesSnapshot = isLast
      ? Object.fromEntries(
          Object.keys(checkpoint.body_store_snapshot).map((bid) => [bid, bodiesOut[bid] ?? {}]),
        )
      : {}
    newCheckpoints[fid] = {
      spec: checkpoint.spec,
      result: checkpoint.result,
      repo_snapshot: _snapshotWithBrepGeometry(checkpoint, cpMeta, deps, needing),
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

// ─── TS kernel router ───
//
// The solver registry provides the per-doc solvability gate: a kind-set
// membership check that dispatches a doc to the TS/WASM leaf solvers when
// every feature kind is ported, else the doc cannot be solved at all.
// Re-exported here so `builder.ts` is the canonical integration
// point for wiring the TS kernel into `BuildDeps.trySolveFeature`.
export {
  PORTED_FEATURE_KINDS,
  isDocFullyPorted,
  unportedKinds,
  getSolver,
  createFeatureSolver,
} from './solverRegistry'
