// A PartBundle is a rev-keyed, derivable artifact built from a PartDoc by a
// transient OCC worker (the bundle builder). It carries everything an assembly
// solver needs (meshes, edge curves, and an anchor dict) so the assembly
// worker never touches OCC or runs solveLocally. The bundle is cached in
// IndexedDb keyed by (doc_id, doc_rev); a miss triggers a cold rebuild.

import type { EdgeData, BodyResult, FaceData } from '../types/cad'
import { sha256Hex } from './sha256'

export type AnchorKind = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'line' | 'circle' | 'point'

export interface Anchor {
  kind: AnchorKind
  point: [number, number, number]
  axis: [number, number, number]
  geom_hash: string
  created_by: string
}

/**
 * An anchor's geometry without its match descriptor. This is what leaves the
 * solver for the main thread: `geom_hash` and `created_by` are rev-to-rev
 * migration inputs, and a renderer that could see them would be tempted to
 * match on them.
 *
 * `x_axis` is the anchor's canonical in-plane reference direction carried into
 * the solved pose (R * canonicalPerp(local axis), utils/mateOrientation.ts) --
 * the frame the editor measures roll against when capturing a fixed/sliding
 * mate's `angle`. Optional: static producers may omit it, and the capture then
 * simply writes no angle rather than measuring against a wrong frame.
 */
export type AnchorPose = Pick<Anchor, 'kind' | 'point' | 'axis'> & {
  x_axis?: [number, number, number]
}

export interface EdgeCurve {
  id: string
  kind: 'line' | 'circle' | 'ellipse' | 'b-spline'
  point: [number, number, number]
  axis?: [number, number, number]
  radius?: number  // circle radius; ellipse semi-major
  endpoints: [[number, number, number], [number, number, number]]

  // Parametric fields, carried for rendering only (utils/edgeSampling.ts); the
  // mate solve never reads them. Endpoints alone cannot reconstruct a curve: a
  // full circle's two endpoints coincide, an ellipse has no minor radius on the
  // wire, and a spline's interior is gone. Optional because a bundle cached
  // before these existed still has to sample (it degrades to a chord).
  x_axis?: [number, number, number]  // in-plane origin of the sweep; angles measure from here
  minor_radius?: number              // ellipse semi-minor
  angle_start?: number
  angle_end?: number
  points?: [number, number, number][]  // b-spline: the tessellated polyline
}

/**
 * Which anchors a picked entity offers as mate references. Indexed
 * positionally: `faces[i]` for the B-rep face `faceIdsPerTriangle` names, and
 * `edges[i]` / `vertices[i]` for the i-th edge / vertex of the source body.
 *
 * One entity maps to a LIST, never a single id: a pick contract that returned a
 * singleton could not express the corner where three faces, three edges and a
 * vertex all sit under one pixel. An entity with no matable anchor (a freeform
 * face, an ellipse edge) carries an empty list: not an error, just not matable.
 */
export interface EntityAnchorIndex {
  faces: string[][]
  edges: string[][]
  vertices: string[][]
}

export interface BodyMesh {
  mesh: {
    vertices: Float32Array
    indices: Uint32Array
    faceIdsPerTriangle: Uint32Array
  }
  edges: EdgeCurve[]
  // Optional so a bundle cached before entityAnchors existed still solves; it
  // just offers no mate picks until its part is rebuilt at a new rev.
  entityAnchors?: EntityAnchorIndex
}

export interface PartBundle {
  doc_id: string
  doc_rev: number
  schema: number
  bodies: BodyMesh[]
  anchors: Record<string, Anchor>
}

/**
 * Bumped whenever a bundle field's MEANING changes in a way that would strand
 * a cached bundle with stale semantics (not just a new optional field). The
 * `surface_frame`-derived anchor axes change is the first such case: a bundle
 * cached under an older schema keeps its wrong cylinder/cone/sphere/torus axes
 * forever unless the cache treats a schema mismatch as a miss. See
 * `bundleCache.bundleCacheGet`.
 */
export const BUNDLE_SCHEMA = 1

// Bumped whenever geometry-producing code changes at an unchanged BUNDLE_SCHEMA
// (a tessellation tweak, a boolean-op fix, a builder behavior change). The
// anchor worker owns the bundle cache and cannot see builder code versions, so
// this id is the only signal it has that a cached bundle was built by different
// code. Forgetting to bump it serves stale geometry at unchanged revs; the
// drift guard test in partBundle.test.ts proves the fingerprint folds this id
// in, it cannot catch the forget.
export const BUNDLE_BUILD_ID = 1

// Deterministic fingerprint of the code that produced a bundle. Stamped on the
// cached record and compared at the cache's single call site (bundleCacheGet):
// a mismatch means the record was built by different code and reads back as a
// miss (a derivable artifact cold-rebuilds, never wrong geometry). Derived, not
// hand-set, so it cannot drift from BUNDLE_SCHEMA / BUNDLE_BUILD_ID.
export const BUNDLE_BUILD_FINGERPRINT = buildBundleFingerprint(BUNDLE_SCHEMA, BUNDLE_BUILD_ID)

/** Short deterministic hash of the schema + build id; collision-safe enough to serve as a miss tag. */
export function buildBundleFingerprint(schema: number, buildId: number): string {
  let hash = 5381
  for (const n of [schema, buildId]) {
    hash = ((hash << 5) + hash + n) | 0
  }
  return `bundle-${(hash >>> 0).toString(36)}`
}

// ─── Anchor ids are deterministic ───

function shortHash(s: string): string {
  return sha256Hex(s).slice(0, 16)
}

/**
 * An anchor's deterministic identity, shortHash(geom_hash + kind). The geom_hash
 * is the stable `@u|` construction token (or the positional `@gdf|`/`@gde|`/
 * `@gdv|` descriptor), so a rebuilt bundle mints the same id for the same
 * element and a persisted MateRef.anchor survives a cache wipe or schema bump
 * with no migration chain at all. Two elements sharing a geom_hash AND a kind
 * would hash to one id; `toPartBundle` disambiguates those with a suffix (the
 * tier-1 collision rule: never two elements on one id).
 */
export function anchorIdFor(geomHash: string, kind: AnchorKind): string {
  return `a_${shortHash(geomHash + kind)}`
}

// ─── Conversion from BuildResponse output ───

type Vec3 = [number, number, number]

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
  if (len < 1e-15) return [0, 0, 0]
  return [v[0] / len, v[1] / len, v[2] / len]
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5]
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/** Point on a circle at parametric angle, given center, radius, x_axis, and the circle's normal axis. */
function circlePoint(
  center: Vec3, radius: number, axis: Vec3, xAxis: Vec3, angle: number,
): Vec3 {
  const yAxis = normalize(cross(axis, xAxis))
  const ux = normalize(xAxis)
  return [
    center[0] + radius * Math.cos(angle) * ux[0] + radius * Math.sin(angle) * yAxis[0],
    center[1] + radius * Math.cos(angle) * ux[1] + radius * Math.sin(angle) * yAxis[1],
    center[2] + radius * Math.cos(angle) * ux[2] + radius * Math.sin(angle) * yAxis[2],
  ]
}

/** Point on an ellipse at parametric eccentric angle. */
function ellipsePoint(
  center: Vec3, a: number, b: number, axis: Vec3, xAxis: Vec3, angle: number,
): Vec3 {
  const yAxis = normalize(cross(axis, xAxis))
  const ux = normalize(xAxis)
  return [
    center[0] + a * Math.cos(angle) * ux[0] + b * Math.sin(angle) * yAxis[0],
    center[1] + a * Math.cos(angle) * ux[1] + b * Math.sin(angle) * yAxis[1],
    center[2] + a * Math.cos(angle) * ux[2] + b * Math.sin(angle) * yAxis[2],
  ]
}

/** Convert a single EdgeData to an EdgeCurve for the assembly bundle. */
export function toEdgeCurve(ed: EdgeData, edgeQuery: string): EdgeCurve {
  const id = edgeQuery
  switch (ed.kind) {
    case 'line': {
      const dir = sub(ed.end, ed.start)
      return {
        id, kind: 'line',
        point: midpoint(ed.start, ed.end),
        axis: normalize(dir) as Vec3,
        endpoints: [ed.start, ed.end],
      }
    }
    case 'circle':
    case 'arc': {
      const startPt = circlePoint(ed.center, ed.radius, ed.axis, ed.x_axis, ed.angle_start)
      const endPt = circlePoint(ed.center, ed.radius, ed.axis, ed.x_axis, ed.angle_end)
      return {
        id, kind: 'circle',
        point: ed.center,
        axis: ed.axis,
        radius: ed.radius,
        endpoints: [startPt, endPt],
        x_axis: ed.x_axis,
        angle_start: ed.angle_start,
        angle_end: ed.angle_end,
      }
    }
    case 'ellipse': {
      const startPt = ellipsePoint(ed.center, ed.a, ed.b, ed.axis, ed.x_axis, ed.angle_start)
      const endPt = ellipsePoint(ed.center, ed.a, ed.b, ed.axis, ed.x_axis, ed.angle_end)
      return {
        id, kind: 'ellipse',
        point: ed.center,
        axis: ed.axis,
        radius: ed.a,
        endpoints: [startPt, endPt],
        x_axis: ed.x_axis,
        minor_radius: ed.b,
        angle_start: ed.angle_start,
        angle_end: ed.angle_end,
      }
    }
    case 'spline': {
      const pts = ed.points
      const midIdx = Math.floor(pts.length / 2)
      return {
        id, kind: 'b-spline',
        point: pts[midIdx],
        endpoints: [pts[0], pts[pts.length - 1]],
        points: pts,
      }
    }
  }
}

// Both flatteners accept an already-flat typed array too, so a typed-array mesh
// (a possible future producer) is copied, never reused: a bundle's arrays must
// be owned by the bundle, because bundleTransferables transfers them and
// reusing an engine-owned buffer would detach the producer's cache.
function flattenVerts(verts: [number, number, number][] | Float32Array): Float32Array {
  if (verts instanceof Float32Array) return new Float32Array(verts)
  const out = new Float32Array(verts.length * 3)
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i]
    out[i * 3] = v[0]; out[i * 3 + 1] = v[1]; out[i * 3 + 2] = v[2]
  }
  return out
}

function flattenFaces(faces: [number, number, number][] | Uint32Array): Uint32Array {
  if (faces instanceof Uint32Array) return new Uint32Array(faces)
  const out = new Uint32Array(faces.length * 3)
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i]
    out[i * 3] = f[0]; out[i * 3 + 1] = f[1]; out[i * 3 + 2] = f[2]
  }
  return out
}

function toUint32(arr: number[]): Uint32Array {
  const out = new Uint32Array(arr.length)
  for (let i = 0; i < arr.length; i++) out[i] = arr[i]
  return out
}

/** Convert a single BodyResult (raw from tessellation) to a BodyMesh for the bundle. */
export function toBodyMesh(bodyResult: BodyResult): BodyMesh {
  const mesh = bodyResult.mesh
  const edges: EdgeCurve[] = []
  if (bodyResult.edges && bodyResult.edge_queries) {
    for (let i = 0; i < bodyResult.edges.length; i++) {
      edges.push(toEdgeCurve(bodyResult.edges[i], bodyResult.edge_queries[i]))
    }
  }
  if (!mesh) {
    return {
      mesh: {
        vertices: new Float32Array(0),
        indices: new Uint32Array(0),
        faceIdsPerTriangle: new Uint32Array(0),
      },
      edges,
    }
  }
  // Always flatten to a fresh copy; never reuse an engine-owned typed array.
  const vertices = flattenVerts(mesh.vertices as [number, number, number][] | Float32Array)
  const indices = flattenFaces(mesh.faces as [number, number, number][] | Uint32Array)
  const triCount = indices.length / 3
  const faceIdsPerTriangle = mesh.triangle_to_face
    ? toUint32(mesh.triangle_to_face)
    : new Uint32Array(triCount)
  return {
    mesh: { vertices, indices, faceIdsPerTriangle },
    edges,
  }
}

/** Build a PartBundle from the raw solve output (tuples still in place from tessellation). */
export function toPartBundle(
  doc_id: string,
  doc_rev: number,
  bodyResults: Record<string, BodyResult>,
): PartBundle {
  const bodies: BodyMesh[] = []
  // Anchor ids are deterministic from the element's stable geom_hash + kind, so
  // a persisted mate ref survives any rebuild with no cache at all. The old
  // minter drew a random prefix per build, which stranded every ref on a cache
  // wipe. Two elements that hash to one id (a tier-1 collision: same geom_hash,
  // same kind) never share it: the first keeps the bare id, later ones get a
  // disambiguation suffix, mirroring the collision marker anchorIdRemap uses.
  const mintedBaseIds = new Map<string, number>()
  const mintAnchorId = (geomHash: string, kind: AnchorKind): string => {
    const base = anchorIdFor(geomHash, kind)
    const n = mintedBaseIds.get(base) ?? 0
    mintedBaseIds.set(base, n + 1)
    return n === 0 ? base : `${base}_${n + 1}`
  }
  const allAnchors: Record<string, Anchor> = {}
  for (const body of Object.values(bodyResults)) {
    const { anchors, entityAnchors } = extractBodyAnchors(body, mintAnchorId)
    bodies.push({ ...toBodyMesh(body), entityAnchors })
    Object.assign(allAnchors, anchors)
  }
  return { doc_id, doc_rev, schema: BUNDLE_SCHEMA, bodies, anchors: allAnchors }
}

// ─── Anchor extraction ───

function faceTypeToAnchorKind(st: string | null | undefined): AnchorKind | null {
  if (st === 'flatface') return 'plane'
  if (st === 'cylinderface') return 'cylinder'
  if (st === 'coneface') return 'cone'
  if (st === 'sphereface') return 'sphere'
  if (st === 'torusface') return 'torus'
  return null  // skip unsupported (bspline/bezier/other)
}

function edgeAnchorKind(ed: EdgeData): AnchorKind | null {
  if (ed.kind === 'line') return 'line'
  if (ed.kind === 'circle' || ed.kind === 'arc') return 'circle'
  return null  // skip ellipse, spline
}

function edgeAnchorPoint(ed: EdgeData): Vec3 {
  switch (ed.kind) {
    case 'line': return midpoint(ed.start, ed.end)
    case 'circle': case 'arc': return ed.center
    case 'ellipse': return ed.center
    case 'spline': {
      const midIdx = Math.floor(ed.points.length / 2)
      return ed.points[midIdx]
    }
  }
}

/**
 * A face anchor's point + axis. A plane's axis IS its normal (unchanged). A
 * curved face's axis comes ONLY from `surface_frame` -- never from
 * `normal`, which is radial on a cylinder/cone and would make a coaxial mate
 * align two radial vectors instead of two axes. No frame (a bundle built
 * before this field existed, or an unreadable surface class) means no anchor:
 * fail-safe over fail-wrong.
 */
function faceAnchorPointAxis(kind: AnchorKind, fd: FaceData): { point: Vec3; axis: Vec3 } | null {
  if (kind === 'plane') return { point: fd.centroid, axis: fd.normal }
  const frame = fd.surface_frame
  if (!frame) return null
  if (kind === 'sphere') return { point: frame.origin, axis: [0, 0, 1] }
  return { point: frame.origin, axis: frame.axis }
}

function edgeAnchorAxis(ed: EdgeData): Vec3 {
  switch (ed.kind) {
    case 'line': return normalize(sub(ed.end, ed.start))
    case 'circle': case 'arc': return ed.axis
    case 'ellipse': return ed.axis
    case 'spline': return [0, 0, 0]
  }
}

/**
 * Find the descriptor token in an ancestry query string. Query format:
 * `?<hex>;<id1><id2>...:<typeRestriction>`. Each id starts with `@`.
 * Returns the full id including the `@` prefix.
 */
function findDescriptorInQuery(query: string | undefined, prefix: string): string | null {
  // Absent is "no descriptor", never a throw. solidToEdges/solidToVertices emit
  // an EMPTY query array when the body has no `created_by`, while still
  // returning every edge and vertex, so the positional zip below can run off
  // the end. The face path is already immune (solidToMesh pushes '' placeholders
  // to keep face_queries aligned with face_data); this makes the other two
  // degrade the same way instead of taking the whole bundle's anchors down with
  // a TypeError -- toPartBundle's body loop has no per-body catch.
  if (query === undefined) return null
  const searchToken = '@' + prefix
  const idx = query.indexOf(searchToken)
  if (idx === -1) return null
  const endIdx = query.indexOf('@', idx + 1)
  return endIdx === -1 ? query.slice(idx) : query.slice(idx, endIdx)
}

export interface BodyAnchorExtraction {
  anchors: Record<string, Anchor>
  // Positional entity → anchor-id lists, the join a pick needs.
  entityAnchors: EntityAnchorIndex
}

/**
 * Extract all supported anchors from a single BodyResult.
 * Skips freeform (bspline) faces, ellipse/spline edges. All vertices are kept.
 * A skipped entity keeps its slot in `entityAnchors` with an empty list, so the
 * positional join to `faceIdsPerTriangle` / `edges` / `vertices` stays intact.
 * @param mintId factory for deterministic anchor ids within this bundle, keyed
 *        on the anchor's own geom_hash + kind.
 */
export function extractBodyAnchors(
  bodyResult: BodyResult,
  mintId: (geomHash: string, kind: AnchorKind) => string,
): BodyAnchorExtraction {
  const anchors: Record<string, Anchor> = {}
  const entityAnchors: EntityAnchorIndex = { faces: [], edges: [], vertices: [] }
  const created_by = bodyResult.created_by || ''

  const emit = (slot: string[][], anchor: Anchor): void => {
    const id = mintId(anchor.geom_hash, anchor.kind)
    anchors[id] = anchor
    slot[slot.length - 1].push(id)
  }

  // Face anchors: centroid + normal from face_data, kind from surface_type.
  const fqs = bodyResult.mesh?.face_queries
  const fds = bodyResult.mesh?.face_data
  if (fqs && fds) {
    for (let i = 0; i < fqs.length; i++) {
      entityAnchors.faces.push([])
      const desc = findDescriptorInQuery(fqs[i], 'u|') ?? findDescriptorInQuery(fqs[i], 'gdf|')
      if (!desc) continue
      const kind = faceTypeToAnchorKind(fds[i]?.surface_type)
      if (!kind) continue
      const pa = faceAnchorPointAxis(kind, fds[i])
      if (!pa) continue
      emit(entityAnchors.faces, {
        kind,
        point: pa.point,
        axis: pa.axis,
        geom_hash: desc,
        created_by,
      })
    }
  }

  // Edge anchors: representative point + axis from EdgeData.
  if (bodyResult.edges && bodyResult.edge_queries) {
    for (let i = 0; i < bodyResult.edges.length; i++) {
      entityAnchors.edges.push([])
      const ed = bodyResult.edges[i]
      const kind = edgeAnchorKind(ed)
      if (!kind) continue
      const desc = findDescriptorInQuery(bodyResult.edge_queries[i], 'u|') ?? findDescriptorInQuery(bodyResult.edge_queries[i], 'gde|')
      if (!desc) continue
      emit(entityAnchors.edges, {
        kind,
        point: edgeAnchorPoint(ed),
        axis: edgeAnchorAxis(ed),
        geom_hash: desc,
        created_by,
      })
    }
  }

  // Vertex anchors: point from vertices array.
  if (bodyResult.vertices && bodyResult.vertex_queries) {
    for (let i = 0; i < bodyResult.vertices.length; i++) {
      entityAnchors.vertices.push([])
      const desc = findDescriptorInQuery(bodyResult.vertex_queries[i], 'u|') ?? findDescriptorInQuery(bodyResult.vertex_queries[i], 'gdv|')
      if (!desc) continue
      emit(entityAnchors.vertices, {
        kind: 'point',
        point: bodyResult.vertices[i] as Vec3,
        axis: [0, 0, 1],
        geom_hash: desc,
        created_by,
      })
    }
  }

  return { anchors, entityAnchors }
}

// ─── Anchor migration ───

function distSq(a: Vec3, b: Vec3): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
}

/**
 * Match the new bundle's freshly minted anchor ids back onto the old bundle's,
 * so mate refs survive rev-to-rev. Pure function over two anchor dicts: no OCC,
 * no worker. Returns `newId -> oldId` for every anchor that found its ancestor;
 * an unmatched new anchor is absent (it keeps its fresh id) and an unmatched old
 * id simply dies, taking any mate ref that held it to stale-red.
 *
 * Tier 1: exact `geom_hash` match transfers the old id.
 * Tier 2: same `created_by` + same `kind`, unique candidate or nearest by
 *         position. If the nearest is a tie, the old id dies.
 */
export function anchorIdRemap(
  oldAnchors: Record<string, Anchor>,
  newAnchors: Record<string, Anchor>,
): Map<string, string> {
  const remap = new Map<string, string>()
  const oldIds = Object.keys(oldAnchors)
  const newIds = Object.keys(newAnchors)

  if (oldIds.length === 0) return remap

  const newIdConsumed = new Set<string>()
  const oldIdMigrated = new Set<string>()

  // Build geom_hash → new-id lookup for tier-1 exact-match fast path.
  const newByGeomHash = new Map<string, string>()
  for (const id of newIds) {
    const gh = newAnchors[id].geom_hash
    if (!newByGeomHash.has(gh)) newByGeomHash.set(gh, id)
    else newByGeomHash.set(gh, '')  // collision marker, skip tier 1
  }

  // ─── Tier 1: exact geom_hash match ───

  for (const oldId of oldIds) {
    const oldA = oldAnchors[oldId]
    const newId = newByGeomHash.get(oldA.geom_hash)
    if (newId && newId !== '' && !newIdConsumed.has(newId)) {
      remap.set(newId, oldId)
      newIdConsumed.add(newId)
      oldIdMigrated.add(oldId)
    }
  }

  // ─── Tier 2: created_by + kind ───

  // Index remaining (unconsumed) new anchors by (created_by, kind).
  const newByCreatedByKind = new Map<string, string[]>()
  for (const id of newIds) {
    if (!newIdConsumed.has(id)) {
      const key = `${newAnchors[id].created_by}|${newAnchors[id].kind}`
      let list = newByCreatedByKind.get(key)
      if (!list) { list = []; newByCreatedByKind.set(key, list) }
      list.push(id)
    }
  }

  const TIE_EPSILON_SQ = 1e-10

  for (const oldId of oldIds) {
    if (oldIdMigrated.has(oldId)) continue
    const oldA = oldAnchors[oldId]
    const key = `${oldA.created_by}|${oldA.kind}`
    const candidates = newByCreatedByKind.get(key)
    if (!candidates || candidates.length === 0) continue

    if (candidates.length === 1) {
      // Unique candidate, direct match.
      const newId = candidates[0]
      remap.set(newId, oldId)
      newIdConsumed.add(newId)
      oldIdMigrated.add(oldId)
      newByCreatedByKind.set(key, [])
    } else {
      // Multiple candidates, pick nearest by position.
      let bestId = ''
      let bestDist = Infinity
      let secondBestDist = Infinity
      for (const cid of candidates) {
        const d = distSq(oldA.point, newAnchors[cid].point)
        if (d < bestDist - TIE_EPSILON_SQ) {
          secondBestDist = bestDist
          bestDist = d
          bestId = cid
        } else if (d < secondBestDist - TIE_EPSILON_SQ) {
          secondBestDist = d
        }
      }
      if (bestId && Math.abs(bestDist - secondBestDist) >= TIE_EPSILON_SQ) {
        remap.set(bestId, oldId)
        newIdConsumed.add(bestId)
        oldIdMigrated.add(oldId)
        // Remove consumed candidate from pool.
        const remaining = candidates.filter((cid) => cid !== bestId)
        newByCreatedByKind.set(key, remaining)
      }
      // else: ambiguous tie → id dies (fail-safe over fail-wrong).
    }
  }

  return remap
}

function remapEntityAnchors(index: EntityAnchorIndex, remap: Map<string, string>): EntityAnchorIndex {
  const rewrite = (slots: string[][]): string[][] =>
    slots.map(ids => ids.map(id => remap.get(id) ?? id))
  return {
    faces: rewrite(index.faces),
    edges: rewrite(index.edges),
    vertices: rewrite(index.vertices),
  }
}

/**
 * Bundle finalization: rewrite a freshly built bundle's anchor ids to the
 * lineage the newest prior cached bundle established. The anchor dict and the
 * per-body `entityAnchors` join must be rewritten together, because a mate ref resolves
 * through the dict, a pick resolves through the join, and the two disagreeing
 * would let a pick offer an id the solver cannot find.
 */
export function migrateBundle(
  prev: Pick<PartBundle, 'anchors'>,
  next: PartBundle,
): PartBundle {
  const remap = anchorIdRemap(prev.anchors, next.anchors)
  if (remap.size === 0) return next

  const anchors: Record<string, Anchor> = {}
  for (const [newId, anchor] of Object.entries(next.anchors)) {
    anchors[remap.get(newId) ?? newId] = { ...anchor }
  }
  const bodies = next.bodies.map(body => (
    body.entityAnchors
      ? { ...body, entityAnchors: remapEntityAnchors(body.entityAnchors, remap) }
      : body
  ))
  return { ...next, anchors, bodies }
}
