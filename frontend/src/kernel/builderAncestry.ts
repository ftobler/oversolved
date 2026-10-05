// B-rep ancestry registration for the incremental builder: face/edge/vertex
// registrars, the solid/extrusion-feature reconciliation, and the checkpoint
// re-registration pass. Kept out of builder.ts so the orchestration loop stays
// readable.

import {
  clearBodyAncestry,
  emitWire,
  absolute,
  canonical,
  ref,
  evictAncestryAndRegister,
} from './query'
import type { Repository } from './query'
import { faceGeometryHash, edgeGeometryHash, vertexGeometryHash } from './geomHash'
import { normalToFrame } from './types3d'
import type { Body, FeatureCheckpoint } from './types3d'
import type { TessMesh } from './occ/tessellation'
import type { BuildDeps } from './builderTypes'
import { repoFromSnapshot, snapshotRepo } from './builderSnapshot'
import { stableJson } from './builderHash'

// Mesh-free B-rep metadata for a set of bodies: the shape of both
// ``BuildDeps.extractBrepMetadata`` and the build-scoped memoised wrapper the
// solve loop and the checkpoint pass share.
export type MetaExtractor = (
  bodyStore: Record<string, Body>,
  repo: Repository | null,
) => Record<string, Record<string, unknown>>

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
// rather than to a wrong single solid. `reconcileFeatureSolids` keeps the count
// equal to the live body store after every re-solve, so N is the number of
// bodies the feature owns right now.
export function registerSolidAncestry(globalRepo: Repository, body: Body): void {
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
export function registerExtrusionFeature(globalRepo: Repository, featureId: string, sketchId = ''): void {
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
export function reconcileFeatureSolids(
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
    // Mirror the solve loop's shaped-body guard so reconcile registers only
    // what the loop would.
    if (body.shape == null) continue
    registerSolidAncestry(globalRepo, body)
    registerExtrusionFeature(globalRepo, body.created_by || '', body.sketch_id)
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
  // Non-array geometry is treated as absent rather than trusted: both registration
  // passes route the registrar through `_tryRegisterBodyBrepFromMeta`, so a throw
  // costs one body its ancestry, but a deps wiring that hands back the wrong shape
  // still needs `arrayOr` to degrade it to empty rather than throw on it.
  const edges = arrayOr<Record<string, unknown>>(meta['edges'])
  const edgeQueries = arrayOr<string>(meta['edge_queries'], edges.map(() => ''))
  if (edges.length) _registerBrepEdgeAncestry(repo, body, edges, edgeQueries, deps)
  const verts = arrayOr<number[]>(meta['vertices'])
  const vertQueries = arrayOr<string>(meta['vertex_queries'], verts.map(() => ''))
  const vertUuids = arrayOr<string | null>(meta['vertex_uuids'])
  if (verts.length) _registerBrepVertexAncestry(repo, body, verts, vertQueries, vertUuids, deps)
}

// One registrar, one error contract, honoured by BOTH registration passes: a body that
// cannot be identified still solves, it just loses its B-rep ancestry. The solve loop
// (`registerBodyFaces`) always had this; the checkpoint-recovery pass did not, so a
// throw from the registrar's own geometry code (`edgeGeometryHash` on a malformed arc,
// a NaN face/edge sort key) or from a deps wiring that does not shield per body aborted
// the whole build instead of costing one body its ancestry.
function _tryRegisterBodyBrepFromMeta(
  repo: Repository,
  body: Body,
  meta: Record<string, unknown>,
  deps?: BuildDeps,
): boolean {
  try {
    registerBodyBrepFromMeta(repo, body, meta, deps)
    return true
  } catch {
    return false  // partial state possible (clearBodyAncestry already ran); the loop lives with the same
  }
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
export function registerBodyFaces(
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
    return _tryRegisterBodyBrepFromMeta(globalRepo, body, out, deps)  // shared error contract
  } catch {
    // Only the extractor call can still throw to here; the registrar throw is handled
    // inside the wrapper. Non-fatal either way: the body just lacks B-rep ancestry, and
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
 * Re-registering it is pure cost: every face, edge and vertex churns through
 * `evictAncestryAndRegister` and mints fresh eids for the same payloads.
 *
 * `registeredVersions` maps body id -> the version whose ancestry actually landed in the
 * repo this checkpoint was snapshotted from. A body is missing from it when the loop
 * never registered it (a null-shape body) or when its registration silently failed to
 * land (`registerBodyFaces` returned false), so it still needs the pass -- the
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
export function snapshotWithBrepGeometry(
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
    _tryRegisterBodyBrepFromMeta(repo, body, bodiesOut[bodyId] ?? {}, deps)
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
  for (const fid of ownedFids) reconcileFeatureSolids(repo, fid, checkpoint.body_store_snapshot, shapeOwningFids)
  // One serializer, so the "derived indices never reach the persisted shape"
  // guard on snapshotRepo covers this path too.
  return { version: 2, ...snapshotRepo(repo) }
}
