// Port of oversolved/kernel/builder.py.
//
// Orchestrates the feature-stack solve loop with dirty detection, checkpoint
// cache, and incremental rebuild. Feature solvers are injected via a registry so
// this module is testable with mock solvers before the real leaf features are
// ported (2e/2f).

import { sha256Hex } from './sha256'
import { Repository, evictAncestryAndRegister, emitWire, absolute, ref, setCurrentFeatureId } from './query'
import { faceGeometryHash, faceNormalHash, edgeGeometryHash, vertexGeometryHash, isGeomKeyedLineage } from './geomHash'
import { faceTokens, edgeLineageTokens } from './faceQuery'
import { BUILTIN_PLANE_RESULTS } from './solverConstants'
import { normalToFrame } from './types3d'
import type { Body, FeatureCheckpoint, BuildState } from './types3d'
import type { TessMesh } from './occ/tessellation'
import type { OccHandle } from './occ/handleTable'

// ── Types ──────────────────────────────────────────────────────────────────

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
) => FeatureResult

export interface BuildDeps {
  /** Solve a single feature. Called by the orchestration loop. */
  trySolveFeature: FeatureSolver
  /** Register solved geometry / topology into the repo after a feature solves. */
  postRegister: (
    repo: Repository,
    featureId: string,
    feature: Record<string, unknown>,
    result: FeatureResult,
  ) => void
  /** Create a fresh global repository. */
  initGlobalRepo: () => Repository
  /** Tessellate all bodies in the store (triangles for rendering). */
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
  /** Optional: normalize legacy projected_* entity kinds. Defaults to identity. */
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
   *  that future rebuilds restore from again. Mirrors builder.py `_copy_shape`.
   *  When omitted (pure non-OCC tests) the handle is aliased. */
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
  _build_state: BuildState
  pick_bodies?: Record<string, unknown>
  _validation?: RebuildValidation
}

export interface RebuildValidation {
  level: 1 | 2 | 3
  passed: boolean
  fp_only?: boolean
  diffs: Record<string, unknown>
}

// ── Feature key union for dirty detection ──────────────────────────────────

// Keys that are NOT part of a feature's geometric identity: transient hints
// attached to the solve payload that must never participate in dirty detection.
// Everything else on a feature is compared, so any geometry-affecting param
// edit (distance, radius, operation, axis, ...) invalidates the checkpoint.
// A blacklist is chosen deliberately over a whitelist: a missed param here only
// costs a redundant rebuild, whereas a missed param in a whitelist would silently
// serve STALE geometry. ``drag_anchor`` is attached per-drag-tick in useSolver and
// is documented as never belonging to the cache key.
const VOLATILE_FEATURE_KEYS = new Set([
  'drag_anchor',
])

function _normalizeSpec(spec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(spec)) {
    if (!VOLATILE_FEATURE_KEYS.has(k)) out[k] = spec[k]
  }
  return out
}

// ── Dirty detection ────────────────────────────────────────────────────────

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

// ── Shape / body snapshot helpers ───────────────────────────────────────────

// ``mapShape``, when provided, transforms the body's shape handle for the
// snapshot: retain-in-place at checkpoint time, defensive-copy at restore time.
// Without it the handle is aliased (non-OCC tests).
type ShapeMapper = (shape: NonNullable<Body['shape']>) => NonNullable<Body['shape']>

function _copyBody(body: Body, mapShape?: ShapeMapper): Body {
  return {
    id: body.id,
    created_by: body.created_by,
    modified_by: [...body.modified_by],
    shape: (body.shape != null && mapShape) ? mapShape(body.shape) : body.shape,
    sketch_id: body.sketch_id,
    brep_diff: body.brep_diff,
    profile_queries: [...body.profile_queries],
    face_lineage: { ...body.face_lineage },
    edge_lineage: { ...body.edge_lineage },
  }
}

function _snapshotRepo(repo: Repository): Record<string, unknown> {
  return {
    elements: Object.fromEntries(repo.elements),
    ancestral: Object.fromEntries(
      [...repo.ancestral.entries()].map(([k, v]) => [k, { set: [...v.set], eids: [...v.eids] }])
    ),
    byGeomHash: Object.fromEntries(
      [...repo.byGeomHash.entries()].map(([k, v]) => [k, [...v]])
    ),
  }
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
        repo.elements.delete(elementId)
        continue
      }
      seen.add(payloadHash)
      uniqueIds.push(elementId)
    }
    if (uniqueIds.length) {
      entry.eids = uniqueIds
    } else {
      repo.ancestral.delete(key)
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
    repo.byGeomHash = new Map(
      Object.entries(repoSnapshot.byGeomHash as Record<string, string[]>).map(([k, v]) => [k, [...v]])
    )
  }
  _dedupeRepo(repo)
  return repo
}

// ── Hash / validation helpers ───────────────────────────────────────────────

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

// ── B-rep diff hash helpers ──────────────────────────────────────────────

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

// ── Ancestry registration (mirrors Python builder.py) ──────────────────────

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
    if (isGeomKeyedLineage(body.face_lineage, 'gface_')) {
      ancestorIds.push(...faceTokens(centroid, normal, body.face_lineage))
    } else if (body.profile_queries.length) {
      ancestorIds.push(...body.profile_queries)
    }
    const { x_axis, y_axis } = normalToFrame(normal)
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
    }
    const key = [...new Set(ancestorIds)].sort().join('\0')
    const entry = globalRepo.ancestral.get(key)
    const existingIds = entry ? entry.eids : []
    if (existingIds.some((eid) => _stableJson(globalRepo.elements.get(eid)) === _stableJson(payload))) {
      continue
    }
    const indexTag = emitWire(absolute(body.id, `face${faceIdx}`))
    const eid = evictAncestryAndRegister(globalRepo, ancestorIds, payload, indexTag, geomHash)
    const nhash = faceNormalHash(normal)
    globalRepo.byGeomHash.set(nhash, [...(globalRepo.byGeomHash.get(nhash) ?? []), eid])
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
    if (isGeomKeyedLineage(body.edge_lineage, 'gedge_')) {
      ancestorIds.push(...edgeLineageTokens(edge, body.edge_lineage))
    } else if (body.profile_queries.length) {
      ancestorIds.push(...body.profile_queries)
    }
    const edgeType = edge.kind === 'line' ? 'straightedge' : 'edge'
    const payload = {
      type: edgeType,
      body_id: body.id,
      created_by: edgeCreatedBy,
      edge_index: idx,
      kind: edge.kind,
      start: edge.start,
      end: edge.end,
      center: edge.center,
      radius: edge.radius,
      axis: edge.axis,
      x_axis: edge.x_axis,
      angle_start: edge.angle_start,
      angle_end: edge.angle_end,
      classifiers: (edge.classifiers as string[]) ?? [],
    }
    const indexTag = emitWire(absolute(body.id, `edge${idx}`))
    evictAncestryAndRegister(globalRepo, ancestorIds, payload, indexTag, geomHash)
  }
}

function _registerBrepVertexAncestry(
  globalRepo: Repository,
  body: Body,
  vertices: Array<number[]>,
  vertexQueries: string[],
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
    const payload = {
      type: 'vertex',
      body_id: body.id,
      created_by: vertexCreatedBy,
      vertex_index: idx,
      origin: pt,
    }
    const indexTag = emitWire(absolute(body.id, `vertex${idx}`))
    evictAncestryAndRegister(globalRepo, ancestorIds, payload, indexTag, geomHash)
  }
}

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

// Tessellate one body and register its B-rep face/edge/vertex ancestry into the
// live repo (mirrors Python builder.py `_register_body_faces`). Called per
// feature in the build loop so a later feature's face/edge/vertex query resolves
// against an earlier body's geometry (e.g. a circular_array axis edge query).
// `edge_queries`/`vertex_queries` are presence/length gates only in the registrar
// (their content is unused), so length-matched placeholders suffice.
function _registerBodyFaces(
  globalRepo: Repository,
  body: Body,
  deps: BuildDeps,
): void {
  if (body.shape == null) return
  try {
    // Identify off the B-rep alone (no triangulation); fall back to the mesh
    // path when no metadata extractor is wired (pure non-OCC tests).
    const extract = deps.extractBrepMetadata ?? deps.tessellateBodies
    const out = extract({ [body.id]: body }, globalRepo)[body.id]
    if (!out) return
    const mesh = out.mesh as TessMesh | undefined
    if (mesh && !mesh.is_fallback) _registerBrepFaceAncestry(globalRepo, body, mesh, deps)
    const edges = (out.edges as Array<Record<string, unknown>>) ?? []
    const edgeQueries = (out.edge_queries as string[]) ?? edges.map(() => '')
    if (edges.length) _registerBrepEdgeAncestry(globalRepo, body, edges, edgeQueries, deps)
    const verts = (out.vertices as number[][]) ?? []
    const vertQueries = (out.vertex_queries as string[]) ?? verts.map(() => '')
    if (verts.length) _registerBrepVertexAncestry(globalRepo, body, verts, vertQueries, deps)
  } catch {
    // Non-fatal: a body that fails to tessellate just lacks B-rep ancestry, as
    // in Python (it logs a warning and continues).
  }
}

function _snapshotWithBrepGeometry(
  checkpoint: FeatureCheckpoint,
  bodiesOut: Record<string, Record<string, unknown>>,
  deps?: BuildDeps,
): Record<string, unknown> {
  const repo = repoFromSnapshot(checkpoint.repo_snapshot as Record<string, unknown>)
  for (const [bodyId, body] of Object.entries(checkpoint.body_store_snapshot)) {
    const bodyOut = bodiesOut[bodyId] ?? {}
    const mesh = bodyOut['mesh'] as TessMesh | undefined
    if (mesh) {
      _registerBrepFaceAncestry(repo, body, mesh, deps)
    }
    const edges = (bodyOut['edges'] as Array<Record<string, unknown>>) ?? []
    const edgeQueries = (bodyOut['edge_queries'] as string[]) ?? []
    if (edges.length && edgeQueries.length) {
      _registerBrepEdgeAncestry(repo, body, edges, edgeQueries, deps)
    }
    const vertices = (bodyOut['vertices'] as Array<number[]>) ?? []
    const vertexQueries = (bodyOut['vertex_queries'] as string[]) ?? []
    if (vertices.length && vertexQueries.length) {
      _registerBrepVertexAncestry(repo, body, vertices, vertexQueries, deps)
    }
    if (body.created_by) {
      _registerSolidAncestry(repo, body)
      _registerExtrusionFeature(repo, body.created_by, body.sketch_id)
    }
  }
  return {
    version: 2,
    elements: Object.fromEntries(repo.elements),
    ancestral: Object.fromEntries(
      [...repo.ancestral.entries()].map(([k, v]) => [k, { set: [...v.set], eids: [...v.eids] }])
    ),
    byGeomHash: Object.fromEntries(
      [...repo.byGeomHash.entries()].map(([k, v]) => [k, [...v]])
    ),
  }
}

// ── Build orchestration ──────────────────────────────────────────────────────

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

  // Preserve previous topology on full rebuild so area re-ID can fire after
  // entity deletions.  Mirrors Python's _topo_ preservation block.
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

  globalRepo.setFeatureOrder(allFeatures.map((f) => String(f.id ?? '')))

  const featuresById = Object.fromEntries(allFeatures.map((f) => [String(f.id ?? ''), f]))

  // Checkpoint body meshes, keyed by the body's shape OccHandle and captured in
  // the loop below while the shape is still alive. A downstream feature can
  // release/replace a body's shape handle (e.g. fillet calls `table.release` on
  // the pre-fillet solid at filletChamfer.ts), which would leave an earlier
  // checkpoint's snapshot pointing at a freed handle. Freezing the mesh as plain
  // data at checkpoint time means the post-loop assembly never tessellates a
  // dead handle. Mirrors Python builder.py `_shape_tess_cache`.
  const shapeTessCache = new Map<OccHandle, Record<string, unknown>>()
  // Tessellate by the LIVE handle (which persists across checkpoints for an
  // unchanged body, so each unique shape meshes at most once), then alias the
  // frozen mesh onto the checkpoint's independent copy handle. Keying off the
  // copy directly would re-mesh every checkpoint's copy even when the geometry
  // never changed -- a full-rebuild tessellation blowup.
  const captureSnapshotMeshes = (
    live: Record<string, Body>,
    snapshot: Record<string, Body>,
  ): void => {
    for (const [bid, body] of Object.entries(live)) {
      if (body.shape == null) continue
      if (!shapeTessCache.has(body.shape)) {
        const entry = deps.tessellateBodies({ [bid]: body }, null)[bid]
        if (entry) shapeTessCache.set(body.shape, entry)
      }
      const copyHandle = snapshot[bid]?.shape
      const mesh = shapeTessCache.get(body.shape)
      if (copyHandle != null && copyHandle !== body.shape && mesh) {
        shapeTessCache.set(copyHandle, mesh)
      }
    }
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
      captureSnapshotMeshes(bodyStore, cpSnapshot)
      newCheckpoints[fid] = {
        spec: { ...feature },
        result: { status: 'suppressed' },
        repo_snapshot: _snapshotRepo(globalRepo),
        body_store_snapshot: cpSnapshot,
        bodies_snapshot: {},
      }
      result[fid] = { status: 'suppressed' }
      continue
    }

    const modifiedByLenBefore = Object.fromEntries(
      Object.entries(bodyStore).map(([bid, b]) => [bid, b.modified_by.length])
    )

    setCurrentFeatureId(fid)
    try {
      const t0 = performance.now()
      const featureResult = deps.trySolveFeature(feature, globalRepo, bodyStore, featuresById)
      featureResult.solve_ms = performance.now() - t0
      deps.postRegister(globalRepo, fid, feature, featureResult)
      result[fid] = featureResult
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      result[fid] = { status: 'exception', exception: err, solve_ms: 0 }
    } finally {
      setCurrentFeatureId(null)
    }

    for (const [bodyId, body] of Object.entries(bodyStore)) {
      if (!registeredBodyIds.has(bodyId) && body.shape != null) {
        _registerBodyFaces(globalRepo, body, deps)
        _registerSolidAncestry(globalRepo, body)
        _registerExtrusionFeature(globalRepo, body.created_by || '', body.sketch_id)
        registeredBodyIds.add(bodyId)
      } else if (body.shape != null && body.modified_by.length > (modifiedByLenBefore[bodyId] ?? 0)) {
        // Body was modified; re-register faces so downstream features see updates.
        _registerBodyFaces(globalRepo, body, deps)
      }
    }

    const cpSnapshot = _snapshotBodies(bodyStore, retainForCheckpoint(fid))
    captureSnapshotMeshes(bodyStore, cpSnapshot)
    newCheckpoints[fid] = {
      spec: JSON.parse(JSON.stringify(feature)),
      result: JSON.parse(JSON.stringify(result[fid])),
      repo_snapshot: _snapshotRepo(globalRepo),
      body_store_snapshot: cpSnapshot,
      bodies_snapshot: {},
    }
  }

  const activeFids = new Set(allFeatures.map((f) => String(f.id ?? '')))
  globalRepo.gc(activeFids)

  const bodiesOut = deps.tessellateBodies(bodyStore, globalRepo)

  // Rebuild checkpoints for dirty features.
  const cleanPrefixFids = new Set<string>()
  if (options.prevState && firstDirty > 0) {
    for (const fid of options.prevState.feature_order.slice(0, firstDirty)) {
      cleanPrefixFids.add(fid)
    }
  }

  // Seed the final (live) body meshes too, so the last checkpoint's pick_bodies
  // reuse the same tessellation as `bodies` rather than re-meshing.
  for (const [bid, body] of Object.entries(bodyStore)) {
    if (body.shape != null && bodiesOut[bid] && !shapeTessCache.has(body.shape)) {
      shapeTessCache.set(body.shape, bodiesOut[bid])
    }
  }
  // Assemble each dirty checkpoint's bodies_snapshot from the meshes captured in
  // the loop while shapes were alive. Never tessellate here: a downstream
  // feature may already have freed the handle this snapshot references.
  const tessellateCheckpointBody = (body: Body): Record<string, unknown> => {
    if (body.shape == null) return {}
    return shapeTessCache.get(body.shape) ?? {}
  }

  for (const fid of Object.keys(newCheckpoints)) {
    if (cleanPrefixFids.has(fid)) continue
    const checkpoint = newCheckpoints[fid]
    const cpBodies = Object.fromEntries(
      Object.entries(checkpoint.body_store_snapshot).map(([bid, body]) => {
        return [bid, tessellateCheckpointBody(body)]
      })
    )
    newCheckpoints[fid] = {
      spec: checkpoint.spec,
      result: checkpoint.result,
      repo_snapshot: _snapshotWithBrepGeometry(checkpoint, cpBodies, deps),
      body_store_snapshot: checkpoint.body_store_snapshot,
      bodies_snapshot: cpBodies,
    }
  }

  const buildMs = Math.round((performance.now() - t0) * 10) / 10

  const newState: BuildState = {
    feature_order: allFeatures.map((f) => String(f.id ?? '')),
    checkpoints: newCheckpoints,
  }

  let pickBodiesOut: Record<string, unknown> | undefined
  const pickBoundary = options.pickBoundary
  if (pickBoundary != null && pickBoundary > 0 && pickBoundary <= features.length) {
    const targetFid = String(features[pickBoundary - 1].id ?? '')
    const pickCheckpoint = newCheckpoints[targetFid] ?? options.prevState?.checkpoints[targetFid]
    if (pickCheckpoint) {
      const snap = pickCheckpoint.bodies_snapshot
      pickBodiesOut = (Object.keys(snap).length)
        ? snap
        : deps.tessellateBodies(pickCheckpoint.body_store_snapshot, null)
    }
  }

  // Builtin planes are always addressable in the result (port of builder.py's
  // final `result.update(_BUILTIN_PLANE_RESULTS)`).
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

// ── TS kernel router (phase 2g) ──────────────────────────────────────────
//
// The solver registry provides the per-doc fallback router: a kind-set
// membership gate that dispatches a doc to the TS/WASM leaf solvers when
// every feature kind is ported, else signals the caller to fall back to
// Python.  Re-exported here so `builder.ts` is the canonical integration
// point for wiring the TS kernel into `BuildDeps.trySolveFeature`.
export {
  PORTED_FEATURE_KINDS,
  isDocFullyPorted,
  unportedKinds,
  getSolver,
  createFeatureSolver,
} from './solverRegistry'
