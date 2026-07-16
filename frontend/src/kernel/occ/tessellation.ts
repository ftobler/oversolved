/**
 * Iterates a solid's faces, tessellates each one (cadquery-exact, see `tessellateFace`),
 * computes per-face centroid/normal/area/surface type, sorts faces flat-before-curved by
 * (normal, centroid) so a later curved feature can never shift a flat face's index, and
 * assembles the flat vertex/triangle arrays plus `triangle_to_face`.
 *
 * SCOPE: this is the geometry half. The ancestry `face_queries` and the spatial `classifiers`
 * that `_build_face_query` attaches depend on geom_hash / the query system (phase 2c) and are
 * deliberately NOT emitted here; `face_data` carries the geometry only. The mesh geometry is
 * the phase-2b dual-run gate.
 */

import { DisposeScope } from './disposeScope'
import { HandleTable, type OccHandle } from './handleTable'
import type { OccModule, OccShape, OccSubShape } from './occTypes'
import {
  edgeToGeom,
  faceCentroid,
  faceNormal,
  faceSurfaceType,
  readEdgeSamplePoints,
  readSolidEdges,
  readSolidVertices,
  tessellateFace,
  type EdgeSortKey,
  type SurfaceType,
  type Vec3,
} from './primitives'
import { triangleArea, faceSortKey, compareFaceSortKeys, type FaceSortItem } from './shapes'
import { geometryClassifiers, isGeomKeyedLineage, edgeGeometryHash, faceGeometryHash } from '../geomHash'
import { edgeDescriptorOf, emitEdgeDescriptor, emitVertexDescriptor } from '../geomDescriptor'
import { buildFaceQuery, faceTokens, edgeLineageTokens } from '../faceQuery'
import { ref, makeAncestryQuery, constructionUuidToken } from '../query'
import type { EdgeData } from '@/types/cad'

export interface FaceDatum {
  centroid: Vec3
  normal: Vec3
  area: number
  surface_type: SurfaceType
  classifiers?: string[]
}

export interface TessMesh {
  vertices: Vec3[]
  faces: [number, number, number][]
  face_data: FaceDatum[]
  triangle_to_face: number[]
  face_queries: string[]
  /** Per-face boundary edge ancestry queries, aligned with `face_queries`. */
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
  for (; exp.More(); exp.Next()) {
    const face = scope.track(oc.TopoDS.Face_1(exp.Current()))
    const { vertices, triangles } = tessellateFace(oc, scope, face, deflection, angularDeflection)
    raw.push({
      vertices,
      triangles,
      centroid: faceCentroid(oc, scope, face),
      normal: faceNormal(oc, scope, face),
      surfaceType: faceSurfaceType(oc, scope, face),
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
  const sorted = [...rawFaces].sort((a, b) => {
    const ka = faceSortKey(a as FaceSortItem)
    const kb = faceSortKey(b as FaceSortItem)
    return compareFaceSortKeys(ka, kb)
  })

  const vertices: Vec3[] = []
  const faces: [number, number, number][] = []
  const triangleToFace: number[] = []
  const faceData: FaceDatum[] = []

  sorted.forEach((rf, faceIdx) => {
    const { faceArea: area, triangleCount } = appendFaceTriangles(
      vertices,
      faces,
      triangleToFace,
      faceIdx,
      rf.vertices,
      rf.triangles,
    )
    if (triangleCount > 0) {
      faceData.push({ centroid: rf.centroid, normal: rf.normal, area, surface_type: rf.surfaceType })
    }
  })

  return { vertices, faces, face_data: faceData, triangle_to_face: triangleToFace, face_queries: [], is_fallback: false }
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
  const points = readSolidVertices(oc, scope, solid)
  points.push(...readEdgeSamplePoints(oc, scope, solid, SAMPLES_PER_EDGE))
  return bodyFrameFromPoints(points)
}

interface SolidMeshOptions extends TessellateOptions {
  createdBy?: string
  bodyId?: string
  profileQueries?: string[] | null
  faceLineage?: Record<string, string[]> | null
  faceNames?: Record<string, string> | null
}

/**
 * Tessellate a solid (held in `table` under `handle`) to a mesh. Mirrors
 * `solid_to_mesh`: per-face tessellation, flat-before-curved face ordering,
 * `triangle_to_face` mapping, per-face geometry in `face_data`, plus the
 * ancestry `face_queries` and spatial `classifiers` wired here in 2d.
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
    const mesh = assembleMesh(raw)
    const { center, half } = bodyFrame(oc, scope, solid)
    const faceQueries: string[] = []
    for (let faceIdx = 0; faceIdx < mesh.face_data.length; faceIdx++) {
      const fd = mesh.face_data[faceIdx]
      const { classifiers, query } = classifyFace(
        faceIdx, fd.centroid, fd.normal, fd.surface_type, center, half, opts,
      )
      fd.classifiers = classifiers
      if (query) faceQueries.push(query)
    }
    mesh.face_queries = faceQueries
    return mesh
  } finally {
    scope.dispose()
  }
}

// Spatial classifier + ancestry query for one face, given the body frame. The
// single source of truth for both the render mesh (which adds triangles/area)
// and `readShapeFaceMetadata` (which does not), so identification is computed
// identically whether or not the face was triangulated.
function classifyFace(
  faceIdx: number,
  centroid: Vec3,
  normal: Vec3,
  surfaceType: SurfaceType,
  center: Vec3,
  half: Vec3,
  opts: SolidMeshOptions,
): { classifiers: string[]; query: string | null } {
  const classifiers = geometryClassifiers(centroid, center, half)
  // A geom-keyed face lineage suppresses the body-wide profile blob so a single
  // per-face token is not shadowed by a cap (mirrors the edge path / Python).
  const fallbackPq = isGeomKeyedLineage(opts.faceLineage, 'gface_') ? null : opts.profileQueries
  const uuid = opts.faceNames ? (opts.faceNames[faceGeometryHash(centroid, normal)] ?? null) : null
  const query = buildFaceQuery(
    opts.createdBy,
    opts.bodyId,
    faceIdx,
    centroid,
    normal,
    surfaceType,
    fallbackPq,
    faceTokens(centroid, normal, opts.faceLineage ?? null),
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
 * checkpoint registration (`_snapshotWithBrepGeometry`) re-registers off the
 * render mesh and keys eviction on the face index, so a divergence here would
 * shift those indices. If a zero-triangle face ever appears, register the
 * checkpoint snapshot off this metadata too.
 */
export function readShapeFaceMetadata(
  oc: OccModule,
  scope: DisposeScope,
  solid: OccShape,
  opts: SolidMeshOptions = {},
): { face_data: FaceDatum[]; face_queries: string[] } {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(solid, E.TopAbs_FACE, E.TopAbs_SHAPE))
  const faces: FaceSortItem[] = []
  for (; exp.More(); exp.Next()) {
    const face = scope.track(oc.TopoDS.Face_1(exp.Current()))
    faces.push({
      centroid: faceCentroid(oc, scope, face),
      normal: faceNormal(oc, scope, face),
      surfaceType: faceSurfaceType(oc, scope, face),
    })
  }
  faces.sort((a, b) => compareFaceSortKeys(faceSortKey(a), faceSortKey(b)))
  const { center, half } = bodyFrame(oc, scope, solid)
  const face_data: FaceDatum[] = []
  const face_queries: string[] = []
  faces.forEach((face, faceIdx) => {
    const { classifiers, query } = classifyFace(
      faceIdx, face.centroid, face.normal, face.surfaceType, center, half, opts,
    )
    face_data.push({
      centroid: face.centroid,
      normal: face.normal,
      area: 0,
      surface_type: face.surfaceType,
      classifiers,
    })
    if (query) face_queries.push(query)
  })
  return { face_data, face_queries }
}

/** Lexicographic comparator over heterogeneous edge sort keys (number|string). */
export function compareEdgeSortKeys(a: EdgeSortKey, b: EdgeSortKey): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i]
    const y = b[i]
    if (typeof x === 'number' && typeof y === 'number') {
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
  edgeLineage?: Record<string, string[]> | null
  edgeNames?: Record<string, string> | null
}

interface SolidEdgesResult {
  edges: EdgeData[]
  edge_queries: string[]
}

interface SolidVerticesOptions {
  createdBy?: string
  bodyId?: string
  profileQueries?: string[] | null
}

interface SolidVerticesResult {
  vertices: Vec3[]
  vertex_queries: string[]
}

/** AABB center + half-extents from a point cloud; degrades to zero-extent. */
function bodyFrameFromPoints(points: Vec3[]): { center: Vec3; half: Vec3 } {
  if (points.length === 0) return { center: [0, 0, 0], half: [0, 0, 0] }
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      if (p[i] < min[i]) min[i] = p[i]
      if (p[i] > max[i]) max[i] = p[i]
    }
  }
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
 * per-edge ancestry `edge_queries`. Queries are
 * emitted only when `createdBy` is set; the geom-hash token they carry is what
 * the fillet/chamfer resolver matches a picked edge against.
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
    raw.sort((a, b) => compareEdgeSortKeys(a.sortKey, b.sortKey))
    const edges = raw.map((r) => r.ed)
    const edge_queries: string[] = []
    const { createdBy, bodyId } = opts
    if (createdBy) {
      const { center, half } = bodyFrame(oc, scope, solid)
      // With a geom-keyed edge lineage map the body-wide profile blob is
      // suppressed so per-edge tokens are not shadowed (mirrors Python).
      const fallbackPq = isGeomKeyedLineage(opts.edgeLineage, 'gedge_') ? null : (opts.profileQueries ?? null)
      for (const ed of edges) {
        const pt = edgeRepresentativePoint(ed)
        const classifiers = pt ? geometryClassifiers(pt, center, half) : []
        // Descriptor token instead of the old gedge_ digest: tolerant identity
        // in persisted queries (query-descriptor-identity). The digest stays a
        // fail-safe fallback for the rare edge whose dict carries no geometry.
        const desc = edgeDescriptorOf(ed as unknown as Record<string, unknown>)
        const geomToken = desc
          ? emitEdgeDescriptor(desc)
          : ref(edgeGeometryHash(ed as unknown as Record<string, unknown>))
        const uuid = opts.edgeNames
          ? (opts.edgeNames[edgeGeometryHash(ed as unknown as Record<string, unknown>)] ?? null)
          : null
        const edgeType = ed.kind === 'line' ? 'straightedge' : 'edge'
        if (bodyId) {
          const ids: string[] = []
          if (uuid) ids.push(constructionUuidToken(uuid))
          ids.push(geomToken, ref(createdBy), ref(bodyId))
          const eTokens = edgeLineageTokens(ed as unknown as Record<string, unknown>, opts.edgeLineage ?? null)
          if (eTokens.length) ids.push(...eTokens)
          else if (fallbackPq && fallbackPq.length) ids.push(...fallbackPq)
          if (classifiers.length) ids.push(...classifiers.map(ref))
          edge_queries.push(makeAncestryQuery(ids, edgeType))
        } else {
          const ids = [geomToken, ref(createdBy)]
          if (classifiers.length) ids.push(...classifiers.map(ref))
          edge_queries.push(makeAncestryQuery(ids, edgeType))
        }
      }
    }
    return { edges, edge_queries }
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
  const uniq: OccSubShape[] = []
  for (; exp.More(); exp.Next()) {
    const edge = scope.track(oc.TopoDS.Edge_1(exp.Current())) as OccSubShape
    if (!uniq.some((u) => u.IsSame(edge))) uniq.push(edge)
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
    const indexOfEdge = (edge: OccSubShape): number =>
      sortedEdges.findIndex((e) => e.IsSame(edge))

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
      const seen: OccSubShape[] = []
      const queries: string[] = []
      const eexp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_EDGE, E.TopAbs_SHAPE))
      for (; eexp.More(); eexp.Next()) {
        const edge = scope.track(oc.TopoDS.Edge_1(eexp.Current())) as OccSubShape
        if (seen.some((s) => s.IsSame(edge))) continue
        seen.push(edge)
        const idx = indexOfEdge(edge)
        if (idx >= 0 && edgeQueries[idx]) queries.push(edgeQueries[idx])
      }
      return queries
    })
  } finally {
    scope.dispose()
  }
}

/**
 * Unique B-rep vertices of a solid plus per-vertex ancestry `vertex_queries`.
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
    const { createdBy, bodyId } = opts
    if (createdBy) {
      for (const v of vertices) {
        // Descriptor token instead of the old gvertex_ digest (query-descriptor-identity).
        const geomToken = emitVertexDescriptor(v)
        if (bodyId) {
          const ids = [geomToken, ref(createdBy), ref(bodyId)]
          if (opts.profileQueries && opts.profileQueries.length) ids.push(...opts.profileQueries)
          vertex_queries.push(makeAncestryQuery(ids, 'vertex'))
        } else {
          vertex_queries.push(makeAncestryQuery([geomToken, ref(createdBy)], 'vertex'))
        }
      }
    }
    return { vertices, vertex_queries }
  } finally {
    scope.dispose()
  }
}
