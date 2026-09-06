/**
 * Per-Body3D callbacks consumed by the id-buffer pointer dispatcher.
 * Only face-geometry computation remains, edge/vertex hover is now
 * handled entirely via the store's `hoveredSelectionId` field (Body3D
 * resolves the index locally from its query arrays).
 *
 * Lookups here run on every pointer move, so a query resolves through reverse
 * indexes built once at registration rather than by scanning every body's query
 * arrays: on a heavy assembly the scan was O(total faces) of string compares per
 * hover, and `findFaceBoundaryEdges` compounded it with an O(edges) scan per
 * boundary edge.
 */

import type { Mesh3D } from '@/types/cad'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { FACE_LAYER_NAME } from '@/picking/layerNames'
import { parsePickKeyIndex } from '@/picking/pickKey'

export interface BodyDispatchCallbacks {
  featureId: string
  bodyId: string
  mesh: Mesh3D
  edgeQueries: readonly string[] | undefined
  // Curve kind ('line' | 'circle' | 'arc' | 'spline') parallel to edgeQueries.
  edgeKinds?: readonly string[]
  vertexQueries: readonly string[] | undefined
  /** Takes the B-rep face index the lookup below resolved, so the body does not
   *  scan its own query list again on every pointer move. */
  updateFaceGeometryForIndex: (brepFaceIndex: number) => void
  clearFaceGeometry: () => void
}

/** A registration plus its query -> index maps. The maps are null exactly when
 *  the matching query array is absent. `bodyKey` is stored so a resolved face
 *  hit can name its owning body without a reverse walk (face-geometry owner
 *  tracking, pickKey lookup). */
interface BodyEntry {
  cb: BodyDispatchCallbacks
  bodyKey: string
  faceIndex: Map<string, number> | null
  edgeIndex: Map<string, number> | null
  vertexIndex: Map<string, number> | null
}

const byBodyKey = new Map<string, BodyEntry>()
// query -> owning entries, in registration order. An array, not a single entry,
// because two bodies may legitimately carry the same query; the first registered
// one wins the lookup, which is the order the old full scan resolved in.
const faceOwners = new Map<string, BodyEntry[]>()
const edgeOwners = new Map<string, BodyEntry[]>()

// The one body whose updateFaceGeometryForIndex last wrote the shared
// hoveredFaceNormal / hoveredFaceCenter store fields. Only one body's geometry
// is ever live (one pair of fields), so a hover teardown only has to touch that
// body, not walk every registered one on every transition.
let faceGeometryOwnerKey: string | null = null

/** First index of each query (duplicates keep the earliest, matching indexOf). */
function buildIndex(queries: readonly string[] | undefined): Map<string, number> | null {
  if (!queries) return null
  const map = new Map<string, number>()
  for (let i = 0; i < queries.length; i++) {
    if (!map.has(queries[i])) map.set(queries[i], i)
  }
  return map
}

function addOwner(owners: Map<string, BodyEntry[]>, index: Map<string, number> | null, entry: BodyEntry): void {
  if (!index) return
  for (const q of index.keys()) {
    const list = owners.get(q)
    if (list) list.push(entry)
    else owners.set(q, [entry])
  }
}

function removeOwner(owners: Map<string, BodyEntry[]>, index: Map<string, number> | null, entry: BodyEntry): void {
  if (!index) return
  for (const q of index.keys()) {
    const list = owners.get(q)
    if (!list) continue
    const at = list.indexOf(entry)
    if (at >= 0) list.splice(at, 1)
    if (list.length === 0) owners.delete(q)
  }
}

function dropEntry(bodyKey: string, entry: BodyEntry): void {
  byBodyKey.delete(bodyKey)
  removeOwner(faceOwners, entry.faceIndex, entry)
  removeOwner(edgeOwners, entry.edgeIndex, entry)
  if (bodyKey === faceGeometryOwnerKey) faceGeometryOwnerKey = null
}

export function registerBodyCallbacks(bodyKey: string, cb: BodyDispatchCallbacks): () => void {
  // A re-registration under the same key supersedes the previous one; drop its
  // index entries so a stale body can never answer a lookup.
  const previous = byBodyKey.get(bodyKey)
  if (previous) dropEntry(bodyKey, previous)

  const entry: BodyEntry = {
    cb,
    bodyKey,
    faceIndex: buildIndex(cb.mesh.face_queries),
    edgeIndex: buildIndex(cb.edgeQueries),
    vertexIndex: buildIndex(cb.vertexQueries),
  }
  byBodyKey.set(bodyKey, entry)
  addOwner(faceOwners, entry.faceIndex, entry)
  addOwner(edgeOwners, entry.edgeIndex, entry)

  return () => {
    if (byBodyKey.get(bodyKey) !== entry) return
    dropEntry(bodyKey, entry)
    // If this body owns the current hover, clear stale hover state
    const s = useSketchEditorStore.getState()
    const hovered = s.hoveredSelectionId
    if (hovered !== null && ownsQuery(entry, hovered)) {
      s.setHoveredSelectionId(null)
      s.setHoveredPickKey(null)
      s.setHoveredFaceGeometry(null, null)
    }
  }
}

/**
 * Whether `entry` registered `query` in any of its three primitive maps. The
 * old form was `face_queries?.includes(q) ?? edge... ?? vertex...`, whose `??`
 * stopped at the first present array, so a body that has face_queries (almost
 * every real body) could not recognise its own hovered edge or vertex and its
 * teardown stranded the hover. Checking all three is the fix; it matches how
 * faceOwners / edgeOwners are actually built.
 */
function ownsQuery(entry: BodyEntry, query: string): boolean {
  return (
    (entry.faceIndex?.has(query) ?? false)
    || (entry.edgeIndex?.has(query) ?? false)
    || (entry.vertexIndex?.has(query) ?? false)
  )
}

/**
 * Resolve a body edge query to its curve kind ('line' | 'circle' | 'arc' |
 * 'spline'), so the project tool can create the matching projected entity.
 * Returns undefined when the query is not a registered body edge.
 */
export function findEdgeKindForQuery(q: string): string | undefined {
  const entry = edgeOwners.get(q)?.[0]
  if (!entry) return undefined
  return entry.cb.edgeKinds?.[entry.edgeIndex!.get(q)!]
}

/** A resolved face hit: the owning body, its dispatch callbacks and the B-rep
 *  face index. `bodyKey` names the owner so the face-geometry teardown can
 *  target it without walking every body. */
export interface ResolvedFace {
  bodyKey: string
  body: BodyDispatchCallbacks
  index: number
}

export function findBodyForFaceQuery(q: string): ResolvedFace | null {
  const entry = faceOwners.get(q)?.[0]
  if (!entry) return null
  return { bodyKey: entry.bodyKey, body: entry.cb, index: entry.faceIndex!.get(q)! }
}

/**
 * Resolve a hovered face to its owning body and B-rep face index using the
 * hit's per-primitive pickKey (`${bodyKey}#face#${index}`). The pickKey names
 * the exact primitive under the cursor, whereas a face query can be shared by
 * two faces of one body (no minted UUID), in which case findBodyForFaceQuery
 * returns whichever face registered first. Returns null when the key does not
 * name a live registered face.
 */
export function findBodyFaceByPickKey(pickKey: string): ResolvedFace | null {
  for (const [bodyKey, entry] of byBodyKey) {
    const count = entry.cb.mesh.face_queries?.length ?? 0
    const index = parsePickKeyIndex(pickKey, `${bodyKey}#${FACE_LAYER_NAME}#`, count)
    if (index >= 0) return { bodyKey, body: entry.cb, index }
  }
  return null
}

/**
 * Resolve a face query to the projection sources of its boundary edges: one
 * `{ source, kind }` per boundary edge, so the project tool can lower a face
 * pick into a closed wire of projected entities. Returns null when the query is
 * not a registered face or the body carries no per-face edge queries.
 */
export function findFaceBoundaryEdges(q: string): { source: string; kind: string }[] | null {
  const entry = faceOwners.get(q)?.[0]
  if (!entry) return null
  const edgeQs = entry.cb.mesh.face_edge_queries?.[entry.faceIndex!.get(q)!]
  if (!edgeQs || edgeQs.length === 0) return null
  return edgeQs.map((source) => {
    const ei = entry.edgeIndex?.get(source)
    const kind = (ei !== undefined ? entry.cb.edgeKinds?.[ei] : undefined) ?? 'line'
    return { source, kind }
  })
}

/**
 * Compute and store the hovered face's geometry, recording the owning body so a
 * later clearAllBodyHover can target it without a walk. Takes the resolved face
 * (from findBodyFaceByPickKey or findBodyForFaceQuery) so the index it feeds
 * updateFaceGeometryForIndex names the same primitive the highlight isolates.
 */
export function applyHoveredFaceGeometry(found: ResolvedFace): void {
  faceGeometryOwnerKey = found.bodyKey
  found.body.updateFaceGeometryForIndex(found.index)
}

/** Clear the face geometry of the one body that last computed it. */
export function clearAllBodyHover(): void {
  if (faceGeometryOwnerKey === null) return
  byBodyKey.get(faceGeometryOwnerKey)?.cb.clearFaceGeometry()
  faceGeometryOwnerKey = null
}

/** Test helper. */
export function resetBodyCallbacksForTest(): void {
  byBodyKey.clear()
  faceOwners.clear()
  edgeOwners.clear()
  faceGeometryOwnerKey = null
}
