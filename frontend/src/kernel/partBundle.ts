// A PartBundle is a content-hash-keyed, derivable artifact built from a PartDoc
// by a transient OCC worker (the bundle builder). It carries everything an
// assembly solver needs (meshes, edge curves, and an anchor dict) so the
// assembly worker never touches OCC or runs solveLocally. The bundle is cached
// in IndexedDb keyed by (doc_id, content_hash); a miss triggers a cold rebuild.

import type { EdgeData, BodyResult, FaceData, MateAnchorDescriptor } from '../types/cad'
import { sha256Hex } from './sha256'
import { cross, sub } from '@/utils/vec3'

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
  content_hash: string
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

/**
 * Whether an anchor kind carries a meaningful axis. A sphere's and a vertex's
 * axis are placeholders (`[0, 0, 1]`), not geometry: every face kind's axis is
 * its surface frame axis (a plane's normal), a line's is its direction and a
 * circle's is its plane normal. The solve refuses an axis-reading mate on a
 * placeholder axis instead of welding it about an invented direction.
 */
export function anchorKindHasAxis(kind: AnchorKind): boolean {
  return kind === 'plane' || kind === 'cylinder' || kind === 'cone' ||
    kind === 'torus' || kind === 'line' || kind === 'circle'
}

// ─── Conversion from BuildResponse output ───

type Vec3 = [number, number, number]

function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
  if (len < 1e-15) return [0, 0, 0]
  return [v[0] / len, v[1] / len, v[2] / len]
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5]
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
      // `?? ''` because the zip is positional and `edge_queries` can be shorter
      // than `edges` (a bundle produced before solidToEdges padded, or one that
      // arrived from outside this kernel). An unguarded index puts `undefined`
      // into `id`, which is typed `string`: no throw, just a bundle of edges
      // whose id nothing matches.
      edges.push(toEdgeCurve(bodyResult.edges[i], bodyResult.edge_queries[i] ?? ''))
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
  content_hash: string,
  bodyResults: Record<string, BodyResult>,
): PartBundle {
  const bodies: BodyMesh[] = []
  // Anchor ids are deterministic from the element's stable geom_hash + kind, so
  // a persisted mate ref survives any rebuild with no cache at all. The old
  // minter drew a random prefix per build, which stranded every ref on a cache
  // wipe. Two elements that hash to one id (a tier-1 collision: same geom_hash,
  // same kind) never share it: the first keeps the bare id, later ones get a
  // disambiguation suffix.
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
  return { doc_id, content_hash, schema: BUNDLE_SCHEMA, bodies, anchors: allAnchors }
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
  // Absent is "no descriptor", never a throw. solidToEdges/solidToVertices now
  // pad their arrays with '' so the positional zip below cannot run off the end,
  // the way solidToMesh has always padded face_queries -- but a BodyResult can
  // also arrive from outside this kernel (a cached bundle, a remote solve), so
  // this stays a real guard rather than an assertion. Degrading to "unnamed"
  // beats taking the whole bundle's anchors down with a TypeError:
  // toPartBundle's body loop has no per-body catch.
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
 * Each loop below is therefore bounded by its ENTITY array -- `face_data`,
 * `edges`, `vertices` -- and never by the parallel query array. Bounding by the
 * queries is the bug this whole seam keeps producing: the query array is the one
 * that can come up short, and a short `entityAnchors` list silently drops the
 * tail entities out of the join (`assemblyPick` even reads
 * `entityAnchors.faces.length` as the face count).
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
  if (fds) {
    for (let i = 0; i < fds.length; i++) {
      entityAnchors.faces.push([])
      const fd = fds[i]
      const fq = fqs?.[i]
      const desc = findDescriptorInQuery(fq, 'u|') ?? findDescriptorInQuery(fq, 'gdf|')
      if (!desc) continue
      const kind = faceTypeToAnchorKind(fd?.surface_type)
      if (!kind) continue
      const pa = faceAnchorPointAxis(kind, fd)
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
  if (bodyResult.edges) {
    for (let i = 0; i < bodyResult.edges.length; i++) {
      entityAnchors.edges.push([])
      const ed = bodyResult.edges[i]
      const kind = edgeAnchorKind(ed)
      if (!kind) continue
      const eq = bodyResult.edge_queries?.[i]
      const desc = findDescriptorInQuery(eq, 'u|') ?? findDescriptorInQuery(eq, 'gde|')
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
  if (bodyResult.vertices) {
    for (let i = 0; i < bodyResult.vertices.length; i++) {
      entityAnchors.vertices.push([])
      const vq = bodyResult.vertex_queries?.[i]
      const desc = findDescriptorInQuery(vq, 'u|') ?? findDescriptorInQuery(vq, 'gdv|')
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

// The point-distance tie guard shared by the build-time remap and the
// resolve-time descriptor fallback. Two candidates closer than this are a tie,
// and a tie refuses rather than guessing.
export const ANCHOR_TIE_EPSILON_SQ = 1e-10

// The fields descriptor matching reads, a structural subset of both `Anchor`
// and `MateAnchorDescriptor`. A descriptor table and an anchor dict are both
// legal inputs, which is what lets resolve-time matching run on either.
export interface AnchorMatchInput {
  geom_hash: string
  kind: string
  created_by: string
  point: Vec3
}

/** The unique candidate id nearest `p`, or undefined for an empty set or a tie. */
function uniqueNearestId(candidates: [string, AnchorMatchInput][], p: Vec3): string | undefined {
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0][0]
  let bestId: string | undefined
  let bestDist = Infinity
  let secondDist = Infinity
  for (const [id, a] of candidates) {
    const d = distSq(p, a.point)
    if (d < bestDist - ANCHOR_TIE_EPSILON_SQ) {
      secondDist = bestDist
      bestDist = d
      bestId = id
    } else if (d < secondDist - ANCHOR_TIE_EPSILON_SQ) {
      secondDist = d
    }
  }
  return bestId && Math.abs(bestDist - secondDist) >= ANCHOR_TIE_EPSILON_SQ ? bestId : undefined
}

/**
 * Re-find the id of the element a persisted descriptor named, in a freshly
 * built bundle with no cache. The same two tiers the retired anchor remap ran,
 * but the seed is the descriptor on the MateRef instead of a previous cached
 * bundle.
 *
 * Tier 1 is the descriptor's own geom_hash plus kind; a `@u|` token that no
 * longer exists is a gone identity, so it refuses rather than falling to tier
 * 2, which would bind the ref to a same-kind neighbour. Tier 2 is the same
 * `(created_by, kind)` bucket plus the nearest stored point.
 */
export function anchorIdByDescriptor(
  anchors: Record<string, AnchorMatchInput>,
  d: MateAnchorDescriptor,
): string | undefined {
  const all = Object.entries(anchors)

  const exact = all.filter(([, a]) => a.geom_hash === d.geom_hash && a.kind === d.kind)
  if (exact.length > 0) {
    const best = uniqueNearestId(exact, d.point)
    // A tier-1 tie is not a dead end: fall through so the `@u|` refusal and the
    // tier-2 match still get their chance.
    if (best !== undefined) return best
  }

  // A construction UUID that no longer exists means the element's identity is
  // gone. Do not guess positionally; fail-safe over fail-wrong.
  if (d.geom_hash.startsWith('@u|')) return undefined

  const near = all.filter(([, a]) => a.created_by === d.created_by && a.kind === d.kind)
  return uniqueNearestId(near, d.point)
}

/**
 * Re-find the element a persisted descriptor named. Wraps the id-returning
 * `anchorIdByDescriptor` so the solve's anchor resolve keeps its Anchor result.
 */
export function anchorByDescriptor(
  anchors: Record<string, Anchor>,
  d: MateAnchorDescriptor,
): Anchor | undefined {
  const id = anchorIdByDescriptor(anchors, d)
  return id !== undefined ? anchors[id] : undefined
}
