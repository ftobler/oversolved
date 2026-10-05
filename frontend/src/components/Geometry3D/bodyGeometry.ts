import type { Mesh3D, EdgeData } from '@/types/cad'
import { ARC_SEGMENTS } from '@/components/Geometry3D/constants'
import { topoFallbackQuery } from '@/utils/query/selectionId'
// The triangle-soup and per-face boundary helpers live in the utils leaf so the
// assembly pick geometry can use them without importing the UI tree. They are
// re-exported here so the component callers keep their existing import site.
export {
  toNonIndexedPositions,
  faceCount,
  groupTrianglesByFace,
  lazyFaceTriangles,
  buildFaceBoundarySegments,
  extractFaceGeometry,
} from '@/utils/bodyGeometry'
export type { FaceTriangleLookup } from '@/utils/bodyGeometry'
// Imported for local use by resolveFaceQueries and planarFaceFrame below.
import { faceCount, extractFaceGeometry } from '@/utils/bodyGeometry'

export function buildBodyGeometry(mesh: Mesh3D): {
  positions: Float32Array
  indices: Uint32Array
} {
  if (mesh.vertices instanceof Float32Array && mesh.faces instanceof Uint32Array) {
    // Zero-copy path for binary-unpacked geometry.
    return { positions: mesh.vertices, indices: mesh.faces }
  }

  // Validate mesh data to catch NaN/undefined early before it reaches WebGL.
  const tupleVerts = mesh.vertices as [number, number, number][]
  const tupleFaces = mesh.faces as [number, number, number][]
  const vertCount = tupleVerts.length
  for (let i = 0; i < vertCount; i++) {
    const v = tupleVerts[i]
    if (!Array.isArray(v) || v.length !== 3) {
      throw new Error(`Mesh vertex ${i} is not a 3-element array: ${JSON.stringify(v)}`)
    }
    for (let j = 0; j < 3; j++) {
      const coord = v[j]
      if (typeof coord !== 'number' || Number.isNaN(coord) || !Number.isFinite(coord)) {
        throw new Error(`Mesh vertex ${i} has invalid coordinate [${j}]: ${coord}`)
      }
    }
  }
  for (let i = 0; i < tupleFaces.length; i++) {
    const f = tupleFaces[i]
    if (!Array.isArray(f) || f.length !== 3) {
      throw new Error(`Mesh face ${i} is not a 3-element array: ${JSON.stringify(f)}`)
    }
    for (let j = 0; j < 3; j++) {
      const idx = f[j]
      if (typeof idx !== 'number' || idx < 0 || idx >= vertCount || !Number.isInteger(idx)) {
        throw new Error(`Mesh face ${i} has invalid index [${j}]: ${idx} (vertCount=${vertCount})`)
      }
    }
  }

  const positions = new Float32Array(tupleVerts.length * 3)
  tupleVerts.forEach(([x, y, z], i) => {
    positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z
  })
  const indices = new Uint32Array(tupleFaces.length * 3)
  tupleFaces.forEach(([a, b, c], i) => {
    indices[i * 3] = a; indices[i * 3 + 1] = b; indices[i * 3 + 2] = c
  })
  return { positions, indices }
}

/**
 * The query list the face highlight indexes, padded so every rendered B-rep
 * face has one: raw `face_queries` where the kernel supplied a full set, else a
 * topo fallback per missing tail face. The ONE list both the face HighlightIndex
 * and the painter's face runs count from, so a mesh whose kernel returns fewer
 * face queries than the tessellation contains (a defensive-alignment gap, not a
 * crash) still lets the tail faces highlight. Returns the raw array unchanged
 * when no padding is needed (reference-stable for the HighlightIndex memo), and
 * null when the mesh carries no usable face queries, in which case the legacy
 * per-triangle highlight path owns the buffer.
 */
export function resolveFaceQueries(mesh: Mesh3D, bodyId: string): string[] | null {
  const { face_queries, triangle_to_face } = mesh
  if (!face_queries || face_queries.length === 0) return null
  const numTris = faceCount(mesh.faces)
  if (!triangle_to_face || triangle_to_face.length < numTris) return null
  // A query set that already outnumbers the triangles covers every rendered
  // face: a face index exists only where a triangle maps to it, so it is
  // bounded by the triangle count. Skips the scan, which would only confirm it.
  if (face_queries.length >= numTris) return face_queries
  let rendered = face_queries.length
  for (let tri = 0; tri < numTris; tri++) {
    const face = triangle_to_face[tri]
    if (face !== undefined && face + 1 > rendered) rendered = face + 1
  }
  if (rendered === face_queries.length) return face_queries
  return Array.from({ length: rendered }, (_, i) =>
    face_queries[i] || topoFallbackQuery(bodyId, 'face', i))
}

/**
 * The query list every rendered B-rep edge indexes, padded so each has one:
 * raw `edgeQueries` where the kernel supplied a full set, else a topo fallback
 * per missing edge. Mirrors `resolveFaceQueries`: the ONE list both the
 * edge HighlightIndex and the ID layer's registration count from, so a body
 * whose kernel returns fewer edge queries than it has edges still lets the tail
 * edges pick. Returns the raw array unchanged when no padding is needed
 * (reference-stable for the HighlightIndex memo), and null when there is nothing
 * to index at all (no edges and no queries).
 *
 * An EMPTY query counts as missing, not as supplied. `solidToEdges` pads its
 * array with '' so the positional zip holds for consumers that index it; those
 * slots mean "the kernel could not name this edge", which is exactly the case
 * the topo fallback exists for. Reading them as supplied would hand every edge
 * of a body with no `created_by` the same blank key and make none of them pick.
 */
export function resolveEdgeQueries(
  edges: ReadonlyArray<unknown> | undefined,
  edgeQueries: ReadonlyArray<string> | undefined,
  bodyId: string,
): string[] | null {
  const numEdges = edges?.length ?? 0
  const supplied = edgeQueries?.length ?? 0
  const total = Math.max(numEdges, supplied)
  if (total === 0) return null
  if (edgeQueries && supplied >= numEdges && !edgeQueries.some((q) => !q)) return edgeQueries as string[]
  return Array.from({ length: total }, (_, i) =>
    edgeQueries?.[i] || topoFallbackQuery(bodyId, 'edge', i))
}

/**
 * The query list every rendered B-rep vertex indexes, padded like
 * `resolveEdgeQueries`. Null when the body has no vertices (the one state where
 * Body3D drops the whole vertex highlight index), otherwise one query per
 * vertex, raw where the kernel named them and a topo fallback where it fell
 * short -- an '' placeholder from `solidToVertices` counting as short.
 */
export function resolveVertexQueries(
  vertices: ReadonlyArray<[number, number, number]> | undefined,
  vertexQueries: ReadonlyArray<string> | undefined,
  bodyId: string,
): string[] | null {
  if (!vertices || vertices.length === 0) return null
  const supplied = vertexQueries?.length ?? 0
  if (vertexQueries && supplied >= vertices.length && !vertexQueries.some((q) => !q)) return vertexQueries as string[]
  return vertices.map((_, i) => vertexQueries?.[i] || topoFallbackQuery(bodyId, 'vertex', i))
}

// Calculate centroid and normal from face vertices.
export function calculateFaceProperties(faceMesh: { vertices: [number, number, number][] }): { normal: [number, number, number]; center: [number, number, number] } | null {
  let cx = 0, cy = 0, cz = 0
  for (const [x, y, z] of faceMesh.vertices) {
    cx += x; cy += y; cz += z
  }
  const count = faceMesh.vertices.length
  const center: [number, number, number] = [cx / count, cy / count, cz / count]

  if (count < 3) return null

  const [v0, v1, v2] = [faceMesh.vertices[0], faceMesh.vertices[1], faceMesh.vertices[2]]
  const edge1: [number, number, number] = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]]
  const edge2: [number, number, number] = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]]
  const normal: [number, number, number] = [
    edge1[1] * edge2[2] - edge1[2] * edge2[1],
    edge1[2] * edge2[0] - edge1[0] * edge2[2],
    edge1[0] * edge2[1] - edge1[1] * edge2[0],
  ]

  return { normal, center }
}

/**
 * The frame "Normal to" aims the camera along for one B-rep face, or null when
 * the face has none. Hover and selection both read it here so they agree on which
 * faces qualify. Only a face the kernel classified as an OCC plane (`flatface`)
 * has one clean normal; a curved face's local normal at some point does not
 * count, and triangles are never sampled to guess planarity, so a face with no
 * surface metadata is refused too.
 */
export function planarFaceFrame(
  mesh: Mesh3D,
  brepFaceIndex: number,
  triangles?: readonly number[],
): { normal: [number, number, number]; center: [number, number, number] } | null {
  if (mesh.face_data?.[brepFaceIndex]?.surface_type !== 'flatface') return null
  const faceGeo = extractFaceGeometry(mesh, brepFaceIndex, triangles)
  return faceGeo ? calculateFaceProperties(faceGeo) : null
}

function _isValidSegment(p: [number, number, number]): boolean {
  return Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2])
}

// Segment buffer plus the per-segment source-edge index, produced by ONE
// traversal so the map can never disagree with the positions about which
// edges were skipped.
export interface EdgeSegmentGeometry {
  // Flat segment endpoints, 6 floats per segment.
  positions: Float32Array
  // Per-segment edge index into the input `edges` array.
  segmentToEdge: Uint32Array
  // Segments produced per INPUT edge, parallel to `edges` (NOT to
  // `segmentToEdge`): 0 for an edge the builder skipped. Comes from the same
  // single traversal, so the painter's run offsets can never disagree with the
  // built buffer the way an unconditional count did.
  edgeSegmentCounts: number[]
}

// Build the flat segment buffer and its segment -> edge map in one pass, with
// the exact same skip conditions for both outputs. The former split
// (buildEdgeSegments + getEdgeSegmentCounts) counted skipped edges anyway, so
// every later segment was attributed to the previous edge and picked silently
// wrong.
export function buildEdgeSegmentGeometry(edges: EdgeData[]): EdgeSegmentGeometry {
  const parts: number[] = []
  const owners: number[] = []

  for (let edgeIdx = 0; edgeIdx < edges.length; edgeIdx++) {
    const edge = edges[edgeIdx]
    if (edge.kind === 'line') {
      if (_isValidSegment(edge.start) && _isValidSegment(edge.end)) {
        parts.push(...edge.start, ...edge.end)
        owners.push(edgeIdx)
      }
    } else if (edge.kind === 'circle' || edge.kind === 'arc') {
      const { center, radius, x_axis, axis, angle_start, angle_end } = edge
      if (!_isValidSegment(center) || !_isValidSegment(x_axis) || !_isValidSegment(axis)
          || Number.isNaN(radius) || !Number.isFinite(radius)
          || !Number.isFinite(angle_start) || !Number.isFinite(angle_end)) {
        continue
      }
      const sweep = angle_end - angle_start
      // Proportional segment count, at least 2, max ARC_SEGMENTS for full circle.
      const segs = Math.max(2, Math.round(ARC_SEGMENTS * Math.abs(sweep) / (2 * Math.PI)))

      // Orthonormal basis: u = x_axis, v = axis cross u (right-hand y of the circle plane).
      const ux = x_axis[0], uy = x_axis[1], uz = x_axis[2]
      const ax = axis[0],   ay = axis[1],   az = axis[2]
      // v = axis cross x_axis
      const vx = ay * uz - az * uy
      const vy = az * ux - ax * uz
      const vz = ax * uy - ay * ux

      const cx = center[0], cy = center[1], cz = center[2]

      let prevX = cx + radius * (Math.cos(angle_start) * ux + Math.sin(angle_start) * vx)
      let prevY = cy + radius * (Math.cos(angle_start) * uy + Math.sin(angle_start) * vy)
      let prevZ = cz + radius * (Math.cos(angle_start) * uz + Math.sin(angle_start) * vz)

      for (let i = 1; i <= segs; i++) {
        const t = angle_start + sweep * (i / segs)
        const nx = cx + radius * (Math.cos(t) * ux + Math.sin(t) * vx)
        const ny = cy + radius * (Math.cos(t) * uy + Math.sin(t) * vy)
        const nz = cz + radius * (Math.cos(t) * uz + Math.sin(t) * vz)
        parts.push(prevX, prevY, prevZ, nx, ny, nz)
        owners.push(edgeIdx)
        prevX = nx; prevY = ny; prevZ = nz
      }
    } else if (edge.kind === 'spline') {
      const pts = edge.points
      for (let i = 0; i < pts.length - 1; i++) {
        if (_isValidSegment(pts[i]) && _isValidSegment(pts[i + 1])) {
          parts.push(...pts[i], ...pts[i + 1])
          owners.push(edgeIdx)
        }
      }
    } else if (edge.kind === 'ellipse') {
      const { center, a, b, x_axis, axis, angle_start, angle_end } = edge
      if (!_isValidSegment(center) || !_isValidSegment(x_axis) || !_isValidSegment(axis)
          || !Number.isFinite(a) || !Number.isFinite(b)
          || !Number.isFinite(angle_start) || !Number.isFinite(angle_end)) {
        continue
      }
      // p(t) = center + a*cos(t)*u + b*sin(t)*v, with v = axis cross x_axis,
      // swept over the edge's parametric range (partial arc, not full ellipse).
      const ux = x_axis[0], uy = x_axis[1], uz = x_axis[2]
      const nx = axis[0], ny = axis[1], nz = axis[2]
      const vx = ny * uz - nz * uy
      const vy = nz * ux - nx * uz
      const vz = nx * uy - ny * ux
      const cx = center[0], cy = center[1], cz = center[2]
      const sweep = angle_end - angle_start
      const segs = Math.max(2, Math.round(ARC_SEGMENTS * Math.abs(sweep) / (2 * Math.PI)))
      const at = (t: number): [number, number, number] => {
        const ca = a * Math.cos(t), sb = b * Math.sin(t)
        return [cx + ca * ux + sb * vx, cy + ca * uy + sb * vy, cz + ca * uz + sb * vz]
      }
      let prev = at(angle_start)
      for (let i = 1; i <= segs; i++) {
        const cur = at(angle_start + sweep * (i / segs))
        parts.push(...prev, ...cur)
        owners.push(edgeIdx)
        prev = cur
      }
    }
  }

  // Per-edge counts from the SAME owners the traversal already collected: a
  // skipped edge contributes nothing to `owners`, so its count is 0 rather than
  // the unconditional estimate that shifted every later painter run offset.
  const edgeSegmentCounts = new Array<number>(edges.length).fill(0)
  for (let i = 0; i < owners.length; i++) edgeSegmentCounts[owners[i]]++
  return {
    positions: new Float32Array(parts),
    segmentToEdge: new Uint32Array(owners),
    edgeSegmentCounts,
  }
}

// Build a flat Float32Array of line segment endpoints from edge descriptors.
// Each segment contributes 6 floats: [x0,y0,z0, x1,y1,z1].
export function buildEdgeSegments(edges: EdgeData[]): Float32Array {
  return buildEdgeSegmentGeometry(edges).positions
}
