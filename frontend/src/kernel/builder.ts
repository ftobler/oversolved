// Orchestrates the feature-stack solve loop with dirty detection, checkpoint cache, and
// incremental rebuild. Feature solvers are injected via a registry, so this module stays
// testable with mock solvers.

import { sha256Hex } from './sha256'
import { extractErrorMessage } from './errors'
import {
  Repository,
  evictAncestryAndRegister,
  clearBodyAncestry,
  emitWire,
  absolute,
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
   *  the handle is aliased. */
  copyBodyShape?: (shape: NonNullable<Body['shape']>) => NonNullable<Body['shape']>
  /** Evict every shape held by a checkpoint, by owner tag (``releaseOwner``).
   *  Called for prev-state checkpoints that a new build discards. */
  releaseCheckpoint?: (fid: string) => void
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
    if (_stableJson(_normalizeSpec(prevCheckpoint.spec as Record<string, unknown>))
        !== _stableJson(_normalizeSpec(feature))) {
      return i
    }
  }
  return features.length
}

// ─── Shape / body snapshot helpers ───

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
      const payloadHash = JSON.stringify(payload, Object.keys(payload as object).sort())
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

function _stableJson(obj: unknown): string {
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
  return sha256Hex(_stableJson(cp.spec))
}

export function hashResultDict(result: Record<string, unknown>, fpRound?: number | null): string {
  let payload = _stripNonGeometric(result)
  if (fpRound != null) payload = _roundFloats(payload, fpRound)
  return sha256Hex(_stableJson(payload))
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
    const key = [...new Set(ancestorIds)].sort().join('\0')
    const entry = globalRepo.ancestral.get(key)
    const existingIds = entry ? entry.eids : []
    if (existingIds.some((eid) => _stableJson(globalRepo.elements.get(eid)) === _stableJson(payload))) {
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
// entry ends up holding N solid elements. Deliberate: an ambiguous entry makes
// a `:solid`-restricted query fail loud, no production code issues that
// restriction, and body-scoping the key is the change to make when one does.
function _registerSolidAncestry(globalRepo: Repository, body: Body): void {
  if (!body.created_by) return
  globalRepo.registerAncestor([ref(body.created_by)], {
    type: 'solid',
    body_id: body.id,
    created_by: body.created_by,
  })
}

function _registerExtrusionFeature(globalRepo: Repository, featureId: string, sketchId = ''): void {
  if (!featureId) return
  globalRepo.registerAncestor([ref(featureId)], {
    type: 'extrusion-feature',
    feature_id: featureId,
    sketch_id: sketchId,
  })
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
 * `_registerBrepFaceAncestry` (after a `_stableJson` per candidate AND per existing
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
  for (const [bodyId, body] of Object.entries(checkpoint.body_store_snapshot)) {
    // Skip what the feature loop already registered into the very snapshot being
    // rehydrated here: `needing` is empty for a body whose version has not moved since
    // the loop registered it, and its ancestry is therefore already in the snapshot.
    if (needing && !needing.has(bodyId)) continue
    registerBodyBrepFromMeta(repo, body, bodiesOut[bodyId] ?? {}, deps)
    if (body.created_by) {
      _registerSolidAncestry(repo, body)
      _registerExtrusionFeature(repo, body.created_by, body.sketch_id)
    }
  }
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
  // owner frees exactly that checkpoint's copies.
  if (options.prevState && deps.releaseCheckpoint) {
    for (const fid of options.prevState.feature_order.slice(firstDirty)) {
      deps.releaseCheckpoint(fid)
    }
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
      // checkpoint shapes that future rebuilds restore from again.
      Object.assign(bodyStore, _snapshotBodies(checkpoint.body_store_snapshot, deps.copyBodyShape))
      for (const fid of options.prevState.feature_order.slice(0, firstDirty)) {
        result[fid] = options.prevState.checkpoints[fid].result
        newCheckpoints[fid] = options.prevState.checkpoints[fid]
      }
    }
  }

  const registeredBodyIds = new Set(Object.keys(bodyStore))

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
        spec: { ...feature },
        result: { status: 'suppressed' },
        repo_snapshot: snapshotRepo(globalRepo),
        body_store_snapshot: cpSnapshot,
        bodies_snapshot: {},
      }
      registeredAtCheckpoint.set(fid, new Map(registeredVersions))
      result[fid] = { status: 'suppressed' }
      continue
    }

    const modifiedByLenBefore = Object.fromEntries(
      Object.entries(bodyStore).map(([bid, b]) => [bid, b.modified_by.length])
    )

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

    for (const [bodyId, body] of Object.entries(bodyStore)) {
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
      } else if (body.shape != null && body.modified_by.length > (modifiedByLenBefore[bodyId] ?? 0)) {
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

    const cpSnapshot = _snapshotBodies(bodyStore, retainForCheckpoint(fid))
    newCheckpoints[fid] = {
      spec: JSON.parse(JSON.stringify(feature)),
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
  // re-registering it only churned eids and burned `_stableJson` per face per checkpoint.
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
    response._validation = validateIncremental(newState, result, spec, deps)
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
