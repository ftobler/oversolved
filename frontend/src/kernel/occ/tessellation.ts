/**
 * Iterates a solid's faces, tessellates each one (cadquery-exact, see `tessellateFace`),
 * computes per-face centroid/normal/area/surface type, sorts faces flat-before-curved by
 * (normal, centroid) so a later curved feature can never shift a flat face's index, and
 * assembles the flat vertex/triangle arrays plus `triangle_to_face`.
 */

import { DisposeScope } from './disposeScope'
import { HandleTable, type OccHandle } from './handleTable'
import type { OccModule, OccShape, OccSubShape } from './occTypes'
import {
  edgeToGeom,
  faceCentroid,
  faceCylinderAxis,
  faceNormal,
  faceSurfaceFrame,
  faceSurfaceType,
  readEdgeSamplePoints,
  readSolidEdges,
  readSolidVertices,
  SubShapeDedup,
  SubShapeIndexMap,
  tessellateFace,
  type EdgeSortKey,
  type SurfaceFrame,
  type SurfaceType,
  type Vec3,
} from './primitives'
import { triangleArea, faceSortKey, compareFaceSortKeys, type FaceSortItem } from './shapes'
import { geometryClassifiers } from '../geomHash'
import { assertAligned, canonicalEdges, canonicalFaces, canonicalIndex, canonicalVertices } from './bodyNames'
import { elementCreator, newSubShapes } from './modifierAttribution'
import type { BrepDiff } from '../types3d'
import { deriveVertexUuid, orderSplitChildren, type SplitChild } from '../constructionName'
import { shapeNormalFrame, normalizedWorldKey, type NormalFrame } from './constructionLineage'
import { buildFaceQuery } from '../faceQuery'
import { ref, makeAncestryQuery, constructionUuidToken } from '../query'
import type { EdgeData } from '@/types/cad'

export interface FaceDatum {
  centroid: Vec3
  normal: Vec3
  area: number
  surface_type: SurfaceType
  classifiers?: string[]
  // Additive: the curved-surface rotation
  // axis, distinct from `normal` (which is radial on a cylinder/cone). Absent
  // for a plane (normal already IS the axis) and for a bundle built before this
  // field existed -- the anchor extractor falls back to no-anchor, never to
  // `normal`, when this is missing on a curved face.
  surface_frame?: SurfaceFrame
  // Cylinder axis direction; set for cylinderface only (circular-array axis picks).
  axis?: Vec3
}

export interface TessMesh {
  vertices: Vec3[]
  faces: [number, number, number][]
  face_data: FaceDatum[]
  triangle_to_face: number[]
  face_queries: string[]
  // The construction UUID minted into face_queries[i] (null where none). The
  // registrar reads this rather than re-deriving it, so the query a face
  // carries and the element it is registered as agree by construction.
  face_uuids?: (string | null)[]
  // The feature each face is registered under: the last modifier for a face it
  // created, else the body's creator.
  face_created_by?: string[]
  // Per-face boundary edge ancestry queries, aligned with `face_queries`.
  face_edge_queries?: string[][]
  is_fallback: boolean
}

interface TessellateOptions {
  deflection?: number
  angularDeflection?: number
}

/** One face's tessellated geometry plus the metadata the mesh assembly needs. */
export interface RawFaceGeom {
  vertices: Vec3[]
  triangles: [number, number, number][]
  centroid: Vec3
  normal: Vec3
  surfaceType: SurfaceType
  surfaceFrame: SurfaceFrame | null
  // Cylinder axis direction; set for cylinderface only (circular-array axis picks).
  axis?: Vec3
  // The face's position in the shape's canonical order (occ/bodyNames.ts),
  // which indexes the body's `face_uuids`. Never leaves the worker; always set
  // by `readShapeFaces`, optional only for hand-built mesh fixtures.
  canon?: number
}

/**
 * Canonical index of each face an explorer walk visits, in visit order. The
 * canonical order is that walk deduped by IsSame, so a repeat visit (a face
 * shared by two solids of a shell-only shape) maps to its first index.
 */
function canonicalCounter(): (face: OccSubShape) => number {
  const seen = new SubShapeIndexMap()
  let next = 0
  return (face) => {
    const at = seen.get(face)
    if (at >= 0) return at
    seen.set(face, next)
    return next++
  }
}

/** How many canonical faces a `readShapeFaces` walk saw (its distinct `canon`s). */
function canonicalCount(raw: readonly { canon?: number }[]): number {
  let n = 0
  for (const r of raw) if (r.canon !== undefined && r.canon >= n) n = r.canon + 1
  return n
}

/** Mirror of `_sort_shape_faces`: tessellate + classify every face (unsorted). */
export function readShapeFaces(
  oc: OccModule,
  scope: DisposeScope,
  solid: OccShape,
  deflection: number,
  angularDeflection: number,
): RawFaceGeom[] {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(solid, E.TopAbs_FACE, E.TopAbs_SHAPE))
  const raw: RawFaceGeom[] = []
  const canonOf = canonicalCounter()
  for (; exp.More(); exp.Next()) {
    const face = scope.track(oc.TopoDS.Face_1(exp.Current()))
    const canon = canonOf(face as OccSubShape)
    const { vertices, triangles } = tessellateFace(oc, scope, face, deflection, angularDeflection)
    const surfaceType = faceSurfaceType(oc, scope, face)
    // faceCylinderAxis returns null on a degenerate surface; fold to undefined
    // so the optional field stays absent instead of carrying a null.
    const axis = (surfaceType === 'cylinderface' ? faceCylinderAxis(oc, scope, face) : undefined) ?? undefined
    raw.push({
      vertices,
      triangles,
      centroid: faceCentroid(oc, scope, face),
      normal: faceNormal(oc, scope, face),
      surfaceType,
      surfaceFrame: faceSurfaceFrame(oc, scope, face),
      axis,
      canon,
    })
  }
  return raw
}

/**
 * Mirror of `_append_face_triangles`: append one face's triangles to the
 * accumulators, returning (faceArea, triangleCount).
 */
function appendFaceTriangles(
  allVertices: Vec3[],
  allFaces: [number, number, number][],
  triangleToFace: number[],
  faceIdx: number,
  verts: Vec3[],
  tris: [number, number, number][],
): { faceArea: number; triangleCount: number } {
  const offset = allVertices.length
  let area = 0
  for (const v of verts) allVertices.push(v)
  const before = triangleToFace.length
  for (const tri of tris) {
    const i0 = offset + tri[0]
    const i1 = offset + tri[1]
    const i2 = offset + tri[2]
    allFaces.push([i0, i1, i2])
    area += triangleArea(allVertices[i0], allVertices[i1], allVertices[i2])
    triangleToFace.push(faceIdx)
  }
  return { faceArea: area, triangleCount: triangleToFace.length - before }
}

/**
 * Pure mesh assembly from per-face tessellations (no OCC). Sorts faces
 * flat-before-curved by (normal, centroid), then flattens into the
 * vertex/triangle arrays + `triangle_to_face`, mirroring
 * `_tessellate_and_assemble_faces`. Exposed for always-on unit testing.
 */
export function assembleMesh(rawFaces: RawFaceGeom[]): TessMesh {
  return assembleMeshKeeping(rawFaces).mesh
}

/** `assembleMesh`, plus the raw face behind each `face_data` entry, index for index. */
function assembleMeshKeeping(rawFaces: RawFaceGeom[]): { mesh: TessMesh; kept: RawFaceGeom[] } {
  const kept: RawFaceGeom[] = []
  const sorted = [...rawFaces].sort((a, b) => {
    const ka = faceSortKey(a as FaceSortItem)
    const kb = faceSortKey(b as FaceSortItem)
    return compareFaceSortKeys(ka, kb)
  })

  const vertices: Vec3[] = []
  const faces: [number, number, number][] = []
  const triangleToFace: number[] = []
  const faceData: FaceDatum[] = []

  // `triangle_to_face` must index `faceData`, NOT the position in `sorted`: a
  // face that tessellates to nothing is dropped from `faceData` below, and
  // numbering by sorted position would then point every later face's triangles
  // one slot past its own data (verified: three faces, empty middle, yields
  // triangle_to_face [0, 2] against a face_data of length 2). Since a dropped
  // face contributes no triangles, `faceData.length` is exactly the index the
  // entry about to be pushed will occupy.
  sorted.forEach((rf) => {
    const { faceArea: area, triangleCount } = appendFaceTriangles(
      vertices,
      faces,
      triangleToFace,
      faceData.length,
      rf.vertices,
      rf.triangles,
    )
    if (triangleCount > 0) {
      faceData.push({
        centroid: rf.centroid,
        normal: rf.normal,
        area,
        surface_type: rf.surfaceType,
        surface_frame: rf.surfaceFrame ?? undefined,
        axis: rf.axis,
      })
      kept.push(rf)
    }
  })

  return {
    mesh: { vertices, faces, face_data: faceData, triangle_to_face: triangleToFace, face_queries: [], is_fallback: false },
    kept,
  }
}

// Edge samples per curved edge feeding the body AABB. Lines contribute only
// their endpoints; 16 is ample to capture a circular edge's extent and is
// validated against the mesh-AABB result on a cylinder (see tessellation tests).
const SAMPLES_PER_EDGE = 16

/**
 * Edge-sampled B-rep bounding box: the AABB over the solid's vertices UNION
 * samples along its edges (`readEdgeSamplePoints`). Mesh-free, so identification
 * (`cls_*` classifiers on both faces and edges) can be computed without the
 * render tessellation. Unifies the body frame that faces and edges classify
 * against -- previously faces used the mesh-vertex box and edges used the
 * vertex-only box, which disagreed on curved bodies. On a cylinder the circular
 * edges sample the full diameter so this matches the old mesh box; it degrades
 * only on edgeless bulging surfaces (a full sphere), absorbed by the classifier
 * tolerance. `BRepBndLib` would be the one-line swap if that corner ever matters.
 */
export function bodyFrame(oc: OccModule, scope: DisposeScope, solid: OccShape): { center: Vec3; half: Vec3 } {
  // The two point sets are folded separately, never concatenated: an imported
  // STEP assembly has tens of thousands of edges, and `push(...samples)` passes
  // one argument per point, which overflows the call stack well before the
  // geometry itself is a problem. That threw a RangeError out of every
  // identification path, and `tessellateBodies`/`extractBrepMetadata` swallow a
  // per-body throw, so the whole import silently rendered as nothing.
  return bodyFrameFromPoints(
    readSolidVertices(oc, scope, solid),
    readEdgeSamplePoints(oc, scope, solid, SAMPLES_PER_EDGE),
  )
}

interface SolidMeshOptions extends TessellateOptions {
  createdBy?: string
  bodyId?: string
  profileQueries?: string[] | null
  faceAncestry?: Record<string, string[]> | null
  // The body's face UUIDs in the solid's canonical order (Body.face_uuids).
  faceUuids?: (string | null)[] | null
  // The body's last diff and modifier history, for the per-face creator.
  brepDiff?: BrepDiff | null
  modifiedBy?: string[]
}

/** Per canonical face, the feature it is attributed to (modifierAttribution.ts). */
function faceCreators(oc: OccModule, scope: DisposeScope, solid: OccShape, opts: SolidMeshOptions): string[] {
  const createdBy = opts.createdBy ?? ''
  const created = newSubShapes(oc, scope, opts.brepDiff)
  return canonicalFaces(oc, scope, solid).map((f) => elementCreator(created?.faces.has(f) ?? false, createdBy, opts.modifiedBy))
}

/** The uuid of the face at canonical index `canon`, or null. */
function faceUuidAt(opts: SolidMeshOptions, canon: number | undefined): string | null {
  return canon === undefined ? null : (opts.faceUuids?.[canon] ?? null)
}

/**
 * Tessellate a solid (held in `table` under `handle`) to a mesh. Mirrors
 * `solid_to_mesh`: per-face tessellation, flat-before-curved face ordering,
 * `triangle_to_face` mapping, per-face geometry in `face_data`, plus the
 * ancestry `face_queries` and spatial `classifiers` wired here.
 */
export function solidToMesh(
  oc: OccModule,
  table: HandleTable,
  handle: OccHandle,
  opts: SolidMeshOptions = {},
): TessMesh {
  const deflection = opts.deflection ?? 0.1
  const angularDeflection = opts.angularDeflection ?? 0.1
  const solid = table.get(handle)
  const scope = new DisposeScope()
  try {
    const raw = readShapeFaces(oc, scope, solid, deflection, angularDeflection)
    assertAligned(canonicalCount(raw), opts.faceUuids, `${opts.bodyId ?? 'solid'} faces`)
    const { mesh, kept } = assembleMeshKeeping(raw)
    const { center, half } = bodyFrame(oc, scope, solid)
    const faceQueries: string[] = []
    const faceUuids: (string | null)[] = []
    const creators = faceCreators(oc, scope, solid, opts)
    const faceCreatedBy: string[] = []
    for (let faceIdx = 0; faceIdx < mesh.face_data.length; faceIdx++) {
      const fd = mesh.face_data[faceIdx]
      const uuid = faceUuidAt(opts, kept[faceIdx].canon)
      faceUuids.push(uuid)
      const creator = creators[kept[faceIdx].canon ?? -1] ?? opts.createdBy ?? ''
      faceCreatedBy.push(creator)
      const { classifiers, query } = classifyFace(
        faceIdx, fd.centroid, fd.surface_type, center, half, opts, uuid, creator,
      )
      fd.classifiers = classifiers
      // Push a placeholder even when `buildFaceQuery` returns null, so
      // `face_queries[i]` always lines up with `face_data[i]`.
      // `extractBodyAnchors` zips the two by index; a shorter `face_queries`
      // would shift every anchor past the gap onto the WRONG face's geometry
      // instead of just skipping the one face with no query. An empty string
      // is a safe placeholder: `uuidTokenOfQuery('')` returns null,
      // so that face is (correctly) skipped, same as it would have been.
      faceQueries.push(query ?? '')
    }
    mesh.face_queries = faceQueries
    mesh.face_uuids = faceUuids
    mesh.face_created_by = faceCreatedBy
    return mesh
  } finally {
    scope.dispose()
  }
}

// Spatial classifier + ancestry query for one face, given the body frame and
// the face's construction UUID. The single source of truth for both the render
// mesh (which adds triangles/area) and `readShapeFaceMetadata` (which does
// not), so identification is computed identically whether or not the face was
// triangulated. `creator` is the face's attributed feature (`faceCreators`),
// the same one the registrar records, so the query's ancestral net matches it.
function classifyFace(
  faceIdx: number,
  centroid: Vec3,
  surfaceType: SurfaceType,
  center: Vec3,
  half: Vec3,
  opts: SolidMeshOptions,
  uuid: string | null,
  creator: string,
): { classifiers: string[]; query: string | null } {
  const classifiers = geometryClassifiers(centroid, center, half)
  // An EMPTY ancestry token list (a prism cap face) is "no ancestry": read
  // `[]` as absent so the profile-token fallback fires, matching buildFaceQuery
  // and the builder's registered key. A bare createdBy+bodyId net would leave a
  // stale cap UUID with no ancestral recovery.
  const ancestorTokens =
    (uuid && opts.faceAncestry && opts.faceAncestry[uuid] && opts.faceAncestry[uuid].length)
      ? opts.faceAncestry[uuid]
      : null
  const fallbackPq = ancestorTokens ? null : opts.profileQueries
  const query = buildFaceQuery(
    opts.createdBy ? creator : undefined,
    opts.bodyId,
    faceIdx,
    surfaceType,
    fallbackPq,
    ancestorTokens,
    classifiers,
    uuid,
  )
  return { classifiers, query }
}

/**
 * Mesh-free face identification: per-face centroid/normal/surface_type +
 * classifiers + ancestry `face_queries`, in the SAME flat-before-curved
 * `(normal, centroid)` order the render mesh uses, with NO `tessellateFace`.
 * This is the "eyes only" half -- the builder registers B-rep face ancestry from
 * this in the feature loop, so the expensive triangulation happens once,
 * post-loop, for rendering only. `face_data.area` is 0 here (area needs the
 * triangles); registration never reads it.
 *
 * INVARIANT (guarded by faceMetadataReal.test): the face count here must equal
 * `solidToMesh().face_data.length`. The render path's `assembleMesh` DROPS
 * zero-triangle faces, this path does not; they stay in sync only because every
 * B-rep face the system builds tessellates to >=1 triangle. The post-loop
 * checkpoint registration (`snapshotWithBrepGeometry`) re-registers off the
 * render mesh and keys eviction on the face index, so a divergence here would
 * shift those indices. If a zero-triangle face ever appears, register the
 * checkpoint snapshot off this metadata too.
 */
export function readShapeFaceMetadata(
  oc: OccModule,
  scope: DisposeScope,
  solid: OccShape,
  opts: SolidMeshOptions = {},
): { face_data: FaceDatum[]; face_queries: string[]; face_uuids: (string | null)[]; face_created_by: string[] } {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(solid, E.TopAbs_FACE, E.TopAbs_SHAPE))
  const faces: (FaceSortItem & { surfaceFrame: SurfaceFrame | null; canon: number })[] = []
  const canonOf = canonicalCounter()
  for (; exp.More(); exp.Next()) {
    const face = scope.track(oc.TopoDS.Face_1(exp.Current()))
    const canon = canonOf(face as OccSubShape)
    const surfaceType = faceSurfaceType(oc, scope, face)
    const axis = (surfaceType === 'cylinderface' ? faceCylinderAxis(oc, scope, face) : undefined) ?? undefined
    faces.push({
      centroid: faceCentroid(oc, scope, face),
      normal: faceNormal(oc, scope, face),
      surfaceType,
      surfaceFrame: faceSurfaceFrame(oc, scope, face),
      axis,
      canon,
    })
  }
  assertAligned(canonicalCount(faces), opts.faceUuids, `${opts.bodyId ?? 'solid'} faces`)
  faces.sort((a, b) => compareFaceSortKeys(faceSortKey(a), faceSortKey(b)))
  const { center, half } = bodyFrame(oc, scope, solid)
  const face_data: FaceDatum[] = []
  const face_queries: string[] = []
  const face_uuids: (string | null)[] = []
  const creators = faceCreators(oc, scope, solid, opts)
  const face_created_by: string[] = []
  faces.forEach((face, faceIdx) => {
    const uuid = faceUuidAt(opts, face.canon)
    face_uuids.push(uuid)
    face_created_by.push(creators[face.canon])
    const { classifiers, query } = classifyFace(
      faceIdx, face.centroid, face.surfaceType, center, half, opts, uuid, creators[face.canon],
    )
    face_data.push({
      centroid: face.centroid,
      normal: face.normal,
      area: 0,
      surface_type: face.surfaceType,
      classifiers,
      surface_frame: face.surfaceFrame ?? undefined,
      axis: face.axis,
    })
    // Placeholder on a null query, same reasoning as solidToMesh above: keeps
    // face_queries[i] aligned with face_data[i] for extractBodyAnchors's zip.
    face_queries.push(query ?? '')
  })
  return { face_data, face_queries, face_uuids, face_created_by }
}

/** Lexicographic comparator over heterogeneous edge sort keys (number|string). */
export function compareEdgeSortKeys(a: EdgeSortKey, b: EdgeSortKey): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i]
    const y = b[i]
    if (typeof x === 'number' && typeof y === 'number') {
      if (Number.isNaN(x) || Number.isNaN(y)) {
        // A NaN component makes every comparison false, so the sort silently
        // returns an order that depends on the input permutation. Same hazard as
        // compareFaceSortKeys; refuse it loudly here too.
        throw new Error(`edge sort key component ${i} is NaN`)
      }
      if (x < y) return -1
      if (x > y) return 1
    } else {
      const sx = String(x)
      const sy = String(y)
      if (sx < sy) return -1
      if (sx > sy) return 1
    }
  }
  return a.length - b.length
}

interface SolidEdgesOptions {
  createdBy?: string
  bodyId?: string
  profileQueries?: string[] | null
  edgeAncestry?: Record<string, string[]> | null
  // The body's edge UUIDs in the solid's canonical order (Body.edge_uuids).
  edgeUuids?: (string | null)[] | null
  brepDiff?: BrepDiff | null
  modifiedBy?: string[]
}

interface SolidEdgesResult {
  edges: EdgeData[]
  edge_queries: string[]
  // The construction UUID minted into edge_queries[i] (null where none), for
  // the registrar; same contract as TessMesh.face_uuids.
  edge_uuids: (string | null)[]
  // The feature edge_queries[i] names (empty without a `createdBy`).
  edge_created_by: string[]
}

interface SolidVerticesOptions {
  createdBy?: string
  bodyId?: string
  profileQueries?: string[] | null
  // The body's face UUIDs in canonical order (Body.face_uuids). A vertex UUID
  // is derived from the UUIDs of the faces meeting at it, so the emitter needs
  // the face names to walk the adjacency.
  faceUuids?: (string | null)[] | null
  // The body's last diff and modifier history, for the per-vertex creator.
  brepDiff?: BrepDiff | null
  modifiedBy?: string[]
}

interface SolidVerticesResult {
  vertices: Vec3[]
  vertex_queries: string[]
  // Per-vertex construction UUID (null where the vertex could not earn one),
  // parallel to `vertices`. The registrar attaches it to the vertex payload and
  // to `byUuid` so the resolver's UUID tier can resolve a persisted vertex query.
  vertex_uuids: (string | null)[]
  // The feature each vertex is registered under (modifierAttribution.ts).
  vertex_created_by: string[]
}

/**
 * Vertex construction UUIDs derived from face adjacency, one per canonical
 * vertex of `solid` (null where none). A vertex's UUID is the
 * (unordered) set of its adjacent NAMED face UUIDs (`deriveVertexUuid`).
 * Multiplicity (>1 vertex sharing one face set) is ordered by
 * `orderSplitChildren` and refuses on a near-tie -- never fail-wrong. Mirrors
 * the edge derivation, op-independent.
 *
 * ANY non-empty named-face set identifies a vertex; there is no >=3 bar. The
 * bar came from "a vertex is where 3 faces meet", which holds for a box but not
 * for a curved body: a cylinder's two seam vertices each touch only 2 named
 * faces (one cap + the lateral face). They therefore earned no UUID, and unlike
 * a face or an edge a vertex query has no classifier tokens to fall back on, so
 * both collapsed onto the identical `createdBy + bodyId` ancestral string. Since
 * that string is the key of the durable selection, the two were ONE selectable
 * entity and the second could never be added. Naming them off their adjacent
 * face set is the identity fix: the ingredients stay symbolic (face UUIDs), and
 * geometry stays confined to the split-sibling ordering it was already allowed.
 */
function vertexUuidsFromFaces(
  oc: OccModule,
  scope: DisposeScope,
  solid: OccShape,
  vertexPoints: readonly Vec3[],
  faceUuids: readonly (string | null)[],
): (string | null)[] {
  const faces = canonicalFaces(oc, scope, solid)
  assertAligned(faces.length, faceUuids, 'vertex naming faces')
  const vertexIdx = canonicalIndex(canonicalVertices(oc, scope, solid))
  // Canonical vertex index -> its adjacent named face uuids, in first-touch order.
  const adjacency = new Map<number, Set<string>>()
  faces.forEach((face, fi) => {
    const uuid = faceUuids[fi]
    if (!uuid) return
    for (const vertex of canonicalVertices(oc, scope, face)) {
      const vi = vertexIdx.get(vertex)
      if (vi < 0) continue
      let set = adjacency.get(vi)
      if (set === undefined) adjacency.set(vi, (set = new Set()))
      set.add(uuid)
    }
  })

  const out: (string | null)[] = vertexPoints.map(() => null)
  const bySet = new Map<string, number[]>()  // "uuidA|uuidB|uuidC..." -> [vertex index...]
  for (const [vi, uuidSet] of adjacency) {
    const setKey = [...uuidSet].sort().join('|')
    const group = bySet.get(setKey)
    if (group === undefined) bySet.set(setKey, [vi])
    else group.push(vi)
  }
  // Vertex points are world coordinates: normalize them by the solid's span so
  // a uniform resize cancels and the refusal is relative, not unit-dependent.
  let frame: NormalFrame | null = null
  for (const [setKey, group] of bySet) {
    const adjacent = setKey.split('|')
    let ordered: number[] | null = group
    if (group.length > 1) {
      frame ??= shapeNormalFrame(oc, scope, solid)
      const f = frame
      const children: SplitChild<number>[] = group.map((vi) => ({
        item: vi,
        key: normalizedWorldKey(f, vertexPoints[vi]),
      }))
      ordered = orderSplitChildren(children)  // null on a near-tie -> leave unnamed
    }
    if (ordered === null) continue
    ordered.forEach((vi, i) => {
      out[vi] = deriveVertexUuid(adjacent, group.length > 1 ? i : 0)
    })
  }
  return out
}

/** AABB center + half-extents over one or more point clouds; degrades to
 *  zero-extent. Takes the clouds separately so a caller never has to merge two
 *  large arrays just to bound them. */
function bodyFrameFromPoints(...clouds: Vec3[][]): { center: Vec3; half: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  let seen = 0
  for (const points of clouds) {
    seen += points.length
    for (const p of points) {
      for (let i = 0; i < 3; i++) {
        if (p[i] < min[i]) min[i] = p[i]
        if (p[i] > max[i]) max[i] = p[i]
      }
    }
  }
  if (seen === 0) return { center: [0, 0, 0], half: [0, 0, 0] }
  return {
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    half: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2],
  }
}

/** One point standing in for an edge when classifying its position:
 * line midpoint, circle/arc center, spline middle. */
export function edgeRepresentativePoint(ed: EdgeData): Vec3 | null {
  if (ed.kind === 'line') {
    return [(ed.start[0] + ed.end[0]) / 2, (ed.start[1] + ed.end[1]) / 2, (ed.start[2] + ed.end[2]) / 2]
  }
  if (ed.kind === 'spline') {
    const pts = ed.points
    if (pts && pts.length) {
      const m = pts[Math.floor(pts.length / 2)]
      return [m[0], m[1], m[2]]
    }
    return null
  }
  return [ed.center[0], ed.center[1], ed.center[2]]
}

/**
 * Unique edge geometry of a solid, sorted into deterministic indices, plus the
 * per-edge ancestry `edge_queries`, ALWAYS one per edge. A real query is built
 * only when `createdBy` is set; the rest are '' placeholders that keep the
 * positional zip `edges[i]` <-> `edge_queries[i]` intact. `edge_created_by[i]`
 * is the feature the query names, which the registrar registers the edge under.
 */
export function solidToEdges(
  oc: OccModule,
  table: HandleTable,
  handle: OccHandle,
  opts: SolidEdgesOptions = {},
): SolidEdgesResult {
  const solid = table.get(handle)
  const scope = new DisposeScope()
  try {
    const raw = readSolidEdges(oc, scope, solid)
    const canon = canonicalEdges(oc, scope, solid)
    assertAligned(canon.length, opts.edgeUuids, `${opts.bodyId ?? 'solid'} edges`)
    raw.sort((a, b) => compareEdgeSortKeys(a.sortKey, b.sortKey))
    const edges = raw.map((r) => r.ed)
    const edge_uuids = raw.map((r) => opts.edgeUuids?.[r.canon] ?? null)
    const edge_queries: string[] = []
    const edge_created_by: string[] = []
    const { createdBy, bodyId } = opts
    if (createdBy) {
      const { center, half } = bodyFrame(oc, scope, solid)
      // An edge the last modifier created is attributed to it, the same
      // attribution the fillet/chamfer edge index applies.
      const created = newSubShapes(oc, scope, opts.brepDiff)
      edges.forEach((ed, i) => {
        const pt = edgeRepresentativePoint(ed)
        const classifiers = pt ? geometryClassifiers(pt, center, half) : []
        const uuid = edge_uuids[i]
        // An EMPTY edge ancestry token list is "no ancestry": read `[]` as
        // absent so the profile-token fallback fires, matching the builder's
        // registered key (same truthiness trap as classifyFace).
        const ancestorTokens =
          (uuid && opts.edgeAncestry && opts.edgeAncestry[uuid] && opts.edgeAncestry[uuid].length)
            ? opts.edgeAncestry[uuid]
            : null
        const fallbackPq = ancestorTokens ? null : (opts.profileQueries ?? null)
        const edgeType = ed.kind === 'line' ? 'straightedge' : 'edge'
        const isNew = created?.edges.has(canon[raw[i].canon]) ?? false
        const edgeCreatedBy = elementCreator(isNew, createdBy, opts.modifiedBy)
        edge_created_by.push(edgeCreatedBy)
        if (bodyId) {
          const ids: string[] = []
          if (uuid) ids.push(constructionUuidToken(uuid))
          ids.push(ref(edgeCreatedBy), ref(bodyId))
          if (ancestorTokens && ancestorTokens.length) ids.push(...ancestorTokens)
          else if (fallbackPq && fallbackPq.length) ids.push(...fallbackPq)
          if (classifiers.length) ids.push(...classifiers.map(ref))
          edge_queries.push(makeAncestryQuery(ids, edgeType))
        } else {
          const ids = [ref(edgeCreatedBy)]
          if (classifiers.length) ids.push(...classifiers.map(ref))
          edge_queries.push(makeAncestryQuery(ids, edgeType))
        }
      })
    }
    // Pad to one query per edge, like solidToMesh does for faces (see the
    // reasoning there). Without `createdBy` the loop above emits NOTHING while
    // `edges` still holds every edge, and every caller passes
    // `body.created_by || ''` -- so N edges / 0 queries is a state the codebase
    // routinely produces. Consumers zip the two by index, and an unpadded array
    // hands them `undefined` in a field typed `string`. '' is the safe
    // placeholder: it carries no descriptor and no ancestry, so an edge with no
    // query is skipped rather than silently taking a neighbour's identity.
    while (edge_queries.length < edges.length) edge_queries.push('')
    return { edges, edge_queries, edge_uuids, edge_created_by }
  } finally {
    scope.dispose()
  }
}

/** The sorted unique edges of a solid, retaining the OCC sub-shape so a face's
 *  boundary edge can be matched back to its position (and thus its query). The
 *  sort mirrors `solidToEdges` exactly, so index i lines up with `edge_queries[i]`. */
function sortedUniqueEdges(oc: OccModule, scope: DisposeScope, solid: OccShape): OccSubShape[] {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(solid, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  const dedup = new SubShapeDedup()
  const uniq: OccSubShape[] = []
  for (; exp.More(); exp.Next()) {
    const edge = scope.track(oc.TopoDS.Edge_1(exp.Current())) as OccSubShape
    if (dedup.add(edge)) uniq.push(edge)
  }
  const entries = uniq.map((shape) => ({ shape, sortKey: edgeToGeom(oc, scope, shape as unknown as OccShape).sortKey }))
  entries.sort((a, b) => compareEdgeSortKeys(a.sortKey, b.sortKey))
  return entries.map((e) => e.shape)
}

/**
 * For each face of a solid (in the same flat-before-curved order as
 * `solidToMesh().face_queries`), the ancestry queries of its boundary edges.
 * `edgeQueries` is the sorted per-edge query list from `solidToEdges`; each
 * boundary edge is matched to its sorted position by topological identity
 * (`IsSame`) so the returned queries are exactly the ones a direct edge pick
 * would carry. This is what lets the project tool turn a face pick into a closed
 * wire of projected entities (full-brep-projection face silhouette).
 */
export function solidToFaceEdgeQueries(
  oc: OccModule,
  table: HandleTable,
  handle: OccHandle,
  edgeQueries: string[],
): string[][] {
  const solid = table.get(handle)
  const scope = new DisposeScope()
  try {
    const sortedEdges = sortedUniqueEdges(oc, scope, solid)
    // O(1) identity->position lookup, built once. Replaces a per-edge
    // per-face findIndex(IsSame) scan (O(F x E x E)).
    const edgeIndex = new SubShapeIndexMap()
    sortedEdges.forEach((e, i) => edgeIndex.set(e, i))

    // Faces in the same sorted order solidToMesh/readShapeFaceMetadata use.
    const E = oc.TopAbs_ShapeEnum
    const fexp = scope.track(new oc.TopExp_Explorer_2(solid, E.TopAbs_FACE, E.TopAbs_SHAPE))
    const faces: { shape: OccShape; sortKey: number[] }[] = []
    for (; fexp.More(); fexp.Next()) {
      const face = scope.track(oc.TopoDS.Face_1(fexp.Current()))
      const item: FaceSortItem = {
        centroid: faceCentroid(oc, scope, face),
        normal: faceNormal(oc, scope, face),
        surfaceType: faceSurfaceType(oc, scope, face),
      }
      faces.push({ shape: face, sortKey: faceSortKey(item) })
    }
    faces.sort((a, b) => compareFaceSortKeys(a.sortKey, b.sortKey))

    return faces.map(({ shape }) => {
      const seen = new SubShapeDedup()
      const queries: string[] = []
      const eexp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_EDGE, E.TopAbs_SHAPE))
      for (; eexp.More(); eexp.Next()) {
        const edge = scope.track(oc.TopoDS.Edge_1(eexp.Current())) as OccSubShape
        if (!seen.add(edge)) continue
        const idx = edgeIndex.get(edge)
        if (idx >= 0 && edgeQueries[idx]) queries.push(edgeQueries[idx])
      }
      return queries
    })
  } finally {
    scope.dispose()
  }
}

/**
 * Unique B-rep vertices of a solid plus per-vertex ancestry `vertex_queries`,
 * always one per vertex ('' where there is no `createdBy` to name it by).
 * Vertices are not sorted, so the order follows OCC iteration; callers that
 * need geometry parity compare as a set.
 */
export function solidToVertices(
  oc: OccModule,
  table: HandleTable,
  handle: OccHandle,
  opts: SolidVerticesOptions = {},
): SolidVerticesResult {
  const solid = table.get(handle)
  const scope = new DisposeScope()
  try {
    const vertices = readSolidVertices(oc, scope, solid)
    const vertex_queries: string[] = []
    const vertex_uuids: (string | null)[] = vertices.map(() => null)
    const { createdBy, bodyId } = opts
    // A vertex the last modifier created is attributed to it, in the query and
    // in the registered ancestry alike, so the query's ancestral net matches.
    const created = newSubShapes(oc, scope, opts.brepDiff)
    const vertex_created_by = created
      ? canonicalVertices(oc, scope, solid).map((v) => elementCreator(created.vertices.has(v), createdBy ?? '', opts.modifiedBy))
      : vertices.map(() => createdBy ?? '')
    if (createdBy) {
      // Vertex UUID = the set of its adjacent named-face UUIDs (adjacency-derived,
      // op-independent). A vertex query carries only its @u| UUID (whenever it
      // touches at least one named face) plus the ancestral tokens. A vertex with
      // no named neighbour at all falls back to the ancestral net; that net is
      // shared with its siblings, so such a vertex is not individually selectable
      // -- the fail-safe outcome of having nothing symbolic to name it by.
      // `readSolidVertices` walks the canonical vertex order, so index idx of
      // `vertices` is canonical vertex idx.
      const uuids = opts.faceUuids ? vertexUuidsFromFaces(oc, scope, solid, vertices, opts.faceUuids) : null
      for (let idx = 0; idx < vertices.length; idx++) {
        const uuid = uuids?.[idx] ?? null
        vertex_uuids[idx] = uuid
        const ids: string[] = []
        if (uuid) ids.push(constructionUuidToken(uuid))
        ids.push(ref(vertex_created_by[idx]))
        if (bodyId) {
          ids.push(ref(bodyId))
          if (opts.profileQueries && opts.profileQueries.length) ids.push(...opts.profileQueries)
        }
        vertex_queries.push(makeAncestryQuery(ids, 'vertex'))
      }
    }
    // One query per vertex even with no `createdBy`, for the reason spelled out
    // in solidToEdges: the positional zip is the contract, '' is the placeholder.
    while (vertex_queries.length < vertices.length) vertex_queries.push('')
    return { vertices, vertex_queries, vertex_uuids, vertex_created_by }
  } finally {
    scope.dispose()
  }
}
