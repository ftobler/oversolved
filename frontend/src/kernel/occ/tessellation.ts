/**
 * Port of the `geometry_tessellation.py` mesh core (`solid_to_mesh` /
 * `_tessellate_and_assemble_faces` / `_sort_shape_faces` /
 * `_append_face_triangles`).
 *
 * Iterates a solid's faces, tessellates each one (cadquery-exact, see
 * `tessellateFace`), computes per-face centroid/normal/area/surface type, sorts
 * faces flat-before-curved by (normal, centroid) so a later curved feature can
 * never shift a flat face's index, and assembles the flat vertex/triangle
 * arrays plus `triangle_to_face`.
 *
 * SCOPE: this is the geometry half. The ancestry `face_queries` and the
 * spatial `classifiers` that `_build_face_query` attaches depend on geom_hash /
 * the query system (phase 2c) and are deliberately NOT emitted here; `face_data`
 * carries the geometry only. The mesh geometry is the phase-2b dual-run gate.
 */

import { DisposeScope } from './disposeScope'
import { HandleTable, type OccHandle } from './handleTable'
import type { OccModule, OccShape } from './occTypes'
import {
  faceCentroid,
  faceNormal,
  faceSurfaceType,
  readSolidEdges,
  readSolidVertices,
  tessellateFace,
  type EdgeSortKey,
  type SurfaceType,
  type Vec3,
} from './primitives'
import { triangleArea, faceSortKey, compareFaceSortKeys, type FaceSortItem } from './shapes'
import type { EdgeData } from '@/types/cad'

export interface FaceDatum {
  centroid: Vec3
  normal: Vec3
  area: number
  surface_type: SurfaceType
}

export interface TessMesh {
  vertices: Vec3[]
  faces: [number, number, number][]
  face_data: FaceDatum[]
  triangle_to_face: number[]
  is_fallback: boolean
}

export interface TessellateOptions {
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
function readShapeFaces(
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

  return { vertices, faces, face_data: faceData, triangle_to_face: triangleToFace, is_fallback: false }
}

/**
 * Tessellate a solid (held in `table` under `handle`) to a mesh. Mirrors
 * `solid_to_mesh`: per-face tessellation, flat-before-curved face ordering,
 * `triangle_to_face` mapping, and per-face geometry in `face_data`.
 */
export function solidToMesh(
  oc: OccModule,
  table: HandleTable,
  handle: OccHandle,
  opts: TessellateOptions = {},
): TessMesh {
  const deflection = opts.deflection ?? 0.1
  const angularDeflection = opts.angularDeflection ?? 0.1
  const solid = table.get(handle)
  const scope = new DisposeScope()
  try {
    return assembleMesh(readShapeFaces(oc, scope, solid, deflection, angularDeflection))
  } finally {
    scope.dispose()
  }
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

/**
 * Unique edge geometry of a solid, sorted into deterministic indices (mirrors
 * `solid_to_edges`, geometry half). `edge_queries` are deferred to 2c.
 */
export function solidToEdges(oc: OccModule, table: HandleTable, handle: OccHandle): EdgeData[] {
  const solid = table.get(handle)
  const scope = new DisposeScope()
  try {
    const raw = readSolidEdges(oc, scope, solid)
    raw.sort((a, b) => compareEdgeSortKeys(a.sortKey, b.sortKey))
    return raw.map((r) => r.ed)
  } finally {
    scope.dispose()
  }
}

/**
 * Unique B-rep vertices of a solid (mirrors `solid_to_vertices`, geometry half).
 * Python does not sort vertices, so the order follows OCC iteration; callers
 * that need parity should compare as a set. `vertex_queries` are deferred to 2c.
 */
export function solidToVertices(oc: OccModule, table: HandleTable, handle: OccHandle): Vec3[] {
  const solid = table.get(handle)
  const scope = new DisposeScope()
  try {
    return readSolidVertices(oc, scope, solid)
  } finally {
    scope.dispose()
  }
}
