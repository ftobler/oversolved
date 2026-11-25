// Render-mesh reuse for the incremental builder: which bodies of this build can
// take a mesh tessellated by an earlier one, and the proof that makes it exact.
//
// The proof is provenance, not history. `modified_by` cannot carry it: a solver
// may replace `body.shape` without pushing to it, and a feature the previous
// build ran in its tail (a fillet now edited into an error, or suppressed) left
// its geometry in that build's final mesh while this build's body never saw it.
// So the builder tracks, per body, the feature since whose checkpoint the body's
// render inputs (shape handle and naming fields) stayed unchanged to the end of
// the build, and stores it beside the final mesh (`mesh_stable_since`). A later
// build may hand that mesh to a body the tail left alone exactly when that
// feature is still in its clean prefix: the previous build's body was the same
// from there to its end, and this build's body is the restored copy of it.
//
// A handle is the geometry proof because no kernel code mutates a body shape in
// place: a feature that changes the geometry assigns a new handle. One thing
// rides on a shape without moving its handle: a triangulation some solver left
// on its faces (a finer one survives the render's mesher). A restore copy drops
// it (`copyShape` copies no mesh), so a reused mesh and a fresh render could in
// principle differ there; the parity oracle below is what would show it, and the
// whole-mesh reuse this generalises always had the same exposure. The naming
// fields are compared by reference, except the two owner maps, which
// `indexModifierDiffs` (occ/modifierAttribution.ts) rebuilds as a new object
// after every feature and so are compared by content.

import type { PartSolid, BuildState, FeatureCheckpoint } from './types3d'

type MeshRecord = Record<string, unknown>
type MeshSet = Record<string, MeshRecord>
type Tessellate = (store: Record<string, PartSolid>) => MeshSet

// ─── Render stamp ───

/** Every input of `tessellateParts` (kernel/solveLocally.ts) a body carries:
 *  equal stamps render equal meshes. */
export interface RenderStamp {
  id: string
  shape: PartSolid['shape']
  created_by: string
  modified_by_len: number
  face_uuids: PartSolid['face_uuids']
  edge_uuids: PartSolid['edge_uuids']
  face_ancestry: PartSolid['face_ancestry']
  edge_ancestry: PartSolid['edge_ancestry']
  face_cap_ancestry: PartSolid['face_cap_ancestry']
  face_owner: PartSolid['face_owner']
  edge_owner: PartSolid['edge_owner']
  profile_queries: PartSolid['profile_queries']
  brep_new: PartSolid['brep_new']
  import_color: PartSolid['import_color']
}

export function renderStamp(part: PartSolid): RenderStamp {
  return {
    id: part.id,
    shape: part.shape,
    created_by: part.created_by,
    modified_by_len: part.modified_by.length,
    face_uuids: part.face_uuids,
    edge_uuids: part.edge_uuids,
    face_ancestry: part.face_ancestry,
    edge_ancestry: part.edge_ancestry,
    face_cap_ancestry: part.face_cap_ancestry,
    face_owner: part.face_owner,
    edge_owner: part.edge_owner,
    profile_queries: part.profile_queries,
    brep_new: part.brep_new,
    import_color: part.import_color,
  }
}

function sameOwners(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((k) => a[k] === b[k])
}

/** True when `live` would tessellate to the same render result as the body
 *  `stamp` was taken from. */
export function unchangedSinceStamp(live: PartSolid, stamp: RenderStamp): boolean {
  return live.shape === stamp.shape
    && live.id === stamp.id
    && live.created_by === stamp.created_by
    && live.modified_by.length === stamp.modified_by_len
    && live.face_uuids === stamp.face_uuids
    && live.edge_uuids === stamp.edge_uuids
    && live.face_ancestry === stamp.face_ancestry
    && live.edge_ancestry === stamp.edge_ancestry
    && live.face_cap_ancestry === stamp.face_cap_ancestry
    && live.profile_queries === stamp.profile_queries
    && live.brep_new === stamp.brep_new
    && live.import_color === stamp.import_color
    && sameOwners(live.face_owner, stamp.face_owner)
    && sameOwners(live.edge_owner, stamp.edge_owner)
}

// ─── Change tracking within one build ───

/**
 * Per body, the last feature of this build that changed its render inputs, or
 * null for a restored body no tail feature has changed. Build-local: never
 * stored in a checkpoint, only resolved into `mesh_stable_since`.
 */
export class PartChangeTracker {
  private readonly stamps = new Map<string, RenderStamp>()
  private readonly since = new Map<string, string | null>()

  // The clean-prefix restore: every body starts unchanged since it.
  markRestored(store: Record<string, PartSolid>): void {
    for (const [bid, body] of Object.entries(store)) {
      this.stamps.set(bid, renderStamp(body))
      this.since.set(bid, null)
    }
  }

  // After feature `fid` solved (and its modifier diffs were indexed): a new
  // body, or one whose stamp moved, was changed by `fid`.
  observe(fid: string, store: Record<string, PartSolid>): void {
    for (const bid of [...this.since.keys()]) {
      if (!(bid in store)) {
        this.since.delete(bid)
        this.stamps.delete(bid)
      }
    }
    for (const [bid, body] of Object.entries(store)) {
      const stamp = this.stamps.get(bid)
      if (stamp && unchangedSinceStamp(body, stamp)) continue
      this.stamps.set(bid, renderStamp(body))
      this.since.set(bid, fid)
    }
  }

  // undefined: the tracker never saw the body (it cannot happen for a body in
  // the store; callers treat it as changed by the last feature).
  changedBy(bid: string): string | null | undefined {
    return this.since.get(bid)
  }
}

// ─── Final render ───

export interface FinalRender {
  parts: MeshSet
  stableSince: Record<string, string>
  // Bodies whose mesh came from an earlier build, for the parity oracle.
  reused: ReadonlySet<string>
  // The previous final checkpoint's whole mesh was taken as is.
  wholeReuse: boolean
}

function nonEmpty(mesh: unknown): mesh is MeshRecord {
  return !!mesh && typeof mesh === 'object' && Object.keys(mesh).length > 0
}

/** The previous build's final checkpoint: the one carrying `mesh_stable_since`.
 *  Found by the marker rather than by position, because a rollback build ends
 *  before the last feature of its order. */
export function finalCheckpointOf(state: BuildState | null | undefined): FeatureCheckpoint | null {
  if (!state) return null
  for (let i = state.feature_order.length - 1; i >= 0; i--) {
    const cp = state.checkpoints[state.feature_order[i]]
    if (cp?.mesh_stable_since) return cp
  }
  return null
}

// On a fully-clean rebuild (nothing dirty) the final bodies are the previous
// build's at the last checkpoint, so that checkpoint's whole stored mesh is
// reused. After a rollback it may be a pick world an earlier solve cached there:
// that covers the same store through the same tessellator, so it serves alike.
// null (fall through to the per-body path) unless every live body maps to a
// non-empty mesh.
function reuseFinalMeshOnCleanRebuild(
  prevState: BuildState | null | undefined,
  featureCount: number,
  firstDirty: number,
  partStore: Record<string, PartSolid>,
  lastFid: string | null,
): MeshSet | null {
  if (!prevState || lastFid == null) return null
  if (firstDirty !== featureCount) return null
  const prevCp = prevState.checkpoints[lastFid]
  if (!prevCp) return null
  const snap = prevCp.bodies_snapshot as MeshSet
  if (!snap || !Object.keys(snap).length) return null
  const out: MeshSet = {}
  for (const [bid, body] of Object.entries(partStore)) {
    if (body.shape == null) continue
    const mesh = snap[bid]
    if (!nonEmpty(mesh)) return null  // incomplete snapshot; re-tessellate
    out[bid] = mesh
  }
  return out
}

// The per-body reuse: a restored body no tail feature changed takes the
// previous final mesh when that mesh's provenance is still in the clean prefix.
// The created_by/modified_by check is implied by the provenance; it is kept as
// the cheap statement of what a clean body is.
function reuseUnchangedPartMeshes(
  prevState: BuildState | null | undefined,
  firstDirty: number,
  partStore: Record<string, PartSolid>,
  tracker: PartChangeTracker,
): { reused: MeshSet; since: Record<string, string> } {
  const reused: MeshSet = {}
  const since: Record<string, string> = {}
  const prevFinal = finalCheckpointOf(prevState)
  if (!prevState || !prevFinal || firstDirty <= 0) return { reused, since }
  const cleanFids = new Set(prevState.feature_order.slice(0, firstDirty))
  const prevMeshes = prevFinal.bodies_snapshot as MeshSet
  const prevSince = prevFinal.mesh_stable_since ?? {}
  for (const [bid, body] of Object.entries(partStore)) {
    if (body.shape == null || tracker.changedBy(bid) !== null) continue
    if (!cleanFids.has(body.created_by)) continue
    if (body.modified_by.some((fid) => !cleanFids.has(fid))) continue
    const stable = prevSince[bid]
    const mesh = prevMeshes[bid]
    if (stable === undefined || !cleanFids.has(stable) || !nonEmpty(mesh)) continue
    reused[bid] = mesh
    since[bid] = stable
  }
  return { reused, since }
}

export function renderFinalParts(input: {
  prevState: BuildState | null | undefined
  featureFids: readonly string[]
  firstDirty: number
  partStore: Record<string, PartSolid>
  tracker: PartChangeTracker
  tessellate: Tessellate
}): FinalRender {
  const { prevState, featureFids, firstDirty, partStore, tracker, tessellate } = input
  const lastFid = featureFids.length ? featureFids[featureFids.length - 1] : null
  const lastCleanFid = firstDirty > 0 ? featureFids[firstDirty - 1] : null

  const whole = reuseFinalMeshOnCleanRebuild(prevState, featureFids.length, firstDirty, partStore, lastFid)
  if (whole && lastFid != null) {
    // No tail ran, so every body is as it stood at the last checkpoint; keep the
    // carried provenance where there is one, it reaches further back.
    const carried = prevState?.checkpoints[lastFid]?.mesh_stable_since ?? {}
    const stableSince: Record<string, string> = {}
    for (const bid of Object.keys(whole)) stableSince[bid] = carried[bid] ?? lastFid
    return { parts: whole, stableSince, reused: new Set(Object.keys(whole)), wholeReuse: true }
  }

  const { reused, since } = reuseUnchangedPartMeshes(prevState, firstDirty, partStore, tracker)
  const toTessellate = Object.fromEntries(Object.entries(partStore).filter(([bid]) => !(bid in reused)))
  const parts = { ...reused, ...tessellate(toTessellate) }
  const stableSince: Record<string, string> = {}
  for (const [bid, body] of Object.entries(partStore)) {
    if (body.shape == null) continue
    const changedBy = tracker.changedBy(bid)
    stableSince[bid] = since[bid]
      ?? (changedBy === null ? lastCleanFid : changedBy)
      ?? lastFid
      ?? ''
  }
  return { parts, stableSince, reused: new Set(Object.keys(reused)), wholeReuse: false }
}

// ─── Pick world ───

/**
 * Mesh the pick world (the bodies at checkpoint `boundaryIndex`) from this
 * build's final render where the body's provenance reaches back to that
 * checkpoint or earlier, so the body there is the final one; tessellate the
 * rest. The old guard (equal `modified_by` lengths in both worlds) is subsumed:
 * a body a later feature modified has its provenance past the boundary.
 */
export function renderPickParts(input: {
  pickStore: Record<string, PartSolid>
  final: FinalRender
  fidIndex: ReadonlyMap<string, number>
  boundaryIndex: number
  tessellate: Tessellate
}): { parts: MeshSet; reused: ReadonlySet<string> } {
  const { pickStore, final, fidIndex, boundaryIndex, tessellate } = input
  const reused: MeshSet = {}
  for (const [bid, body] of Object.entries(pickStore)) {
    if (body.shape == null) continue
    const stable = final.stableSince[bid]
    const at = stable === undefined ? undefined : fidIndex.get(stable)
    const mesh = final.parts[bid]
    if (at === undefined || at > boundaryIndex || !nonEmpty(mesh)) continue
    reused[bid] = mesh
  }
  const toTessellate = Object.fromEntries(Object.entries(pickStore).filter(([bid]) => !(bid in reused)))
  return { parts: { ...reused, ...tessellate(toTessellate) }, reused: new Set(Object.keys(reused)) }
}

/**
 * Memory bound: the final checkpoint keeps its mesh and provenance, `keepFid`
 * (this build's pick checkpoint) keeps its mesh, and every other checkpoint is
 * replaced by a mesh-free copy. Carried checkpoints are shared with the previous
 * state, so they are copied, never edited. The provenance marker stays unique,
 * which is what `finalCheckpointOf` relies on.
 */
export function boundCheckpointMeshes(
  checkpoints: Record<string, FeatureCheckpoint>,
  lastFid: string | null,
  keepFid: string | null,
): void {
  for (const [fid, cp] of Object.entries(checkpoints)) {
    if (fid === lastFid) continue
    const keepMesh = fid === keepFid
    const hasMesh = Object.keys(cp.bodies_snapshot).length > 0
    if (!cp.mesh_stable_since && (keepMesh || !hasMesh)) continue
    const { mesh_stable_since: _dropped, ...rest } = cp
    void _dropped
    checkpoints[fid] = { ...rest, bodies_snapshot: keepMesh ? cp.bodies_snapshot : {} }
  }
}

// ─── Parity oracle ───

/** A reused mesh differs from a fresh tessellation of the same body: the reuse
 *  proof has a hole. `path` names the first differing field. */
export class MeshReuseMismatchError extends Error {
  readonly partId: string
  readonly world: 'final' | 'pick'
  readonly path: string
  constructor(partId: string, world: 'final' | 'pick', path: string) {
    super(`mesh reuse mismatch: ${world} part ${partId} differs from a fresh tessellation at ${path || '(root)'}`)
    this.name = 'MeshReuseMismatchError'
    this.partId = partId
    this.world = world
    this.path = path
  }
}

const ROUND = 1e9

/** The first path at which two render results differ, numbers compared rounded
 *  to 1e-9, or null when they are equal. Typed and tuple arrays compare alike. */
export function firstMeshDifference(a: unknown, b: unknown, path = ''): string | null {
  if (typeof a === 'number' && typeof b === 'number') {
    return Object.is(a, b) || Math.round(a * ROUND) === Math.round(b * ROUND) ? null : path
  }
  const aList = Array.isArray(a) || ArrayBuffer.isView(a)
  const bList = Array.isArray(b) || ArrayBuffer.isView(b)
  if (aList || bList) {
    if (!aList || !bList) return path
    const al = a as ArrayLike<unknown>
    const bl = b as ArrayLike<unknown>
    if (al.length !== bl.length) return `${path}.length`
    for (let i = 0; i < al.length; i++) {
      const d = firstMeshDifference(al[i], bl[i], `${path}[${i}]`)
      if (d !== null) return d
    }
    return null
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    const keys = [...new Set([...Object.keys(ao), ...Object.keys(bo)])].sort()
    for (const k of keys) {
      if (!(k in ao) || !(k in bo)) return `${path}.${k}`
      const d = firstMeshDifference(ao[k], bo[k], `${path}.${k}`)
      if (d !== null) return d
    }
    return null
  }
  return Object.is(a, b) ? null : path
}

/** Tessellate every reused body fresh and throw on the first difference. Debug
 *  only (`BuildOptions.verifyMeshReuse`): it pays the render the reuse saved. */
export function verifyReusedMeshes(
  world: 'final' | 'pick',
  parts: MeshSet,
  reused: ReadonlySet<string>,
  store: Record<string, PartSolid>,
  tessellate: Tessellate,
): void {
  if (!reused.size) return
  const fresh = tessellate(Object.fromEntries([...reused].filter((bid) => bid in store).map((bid) => [bid, store[bid]])))
  for (const bid of [...reused].sort()) {
    if (!(bid in fresh)) throw new MeshReuseMismatchError(bid, world, '(no fresh tessellation)')
    const diff = firstMeshDifference(parts[bid], fresh[bid])
    if (diff !== null) throw new MeshReuseMismatchError(bid, world, diff)
  }
}
