import type { Mesh3D, EdgeData } from '@/types/cad'
import { ARC_SEGMENTS } from '@/components/Geometry3D/constants'
import { topoFallbackQuery } from '@/utils/query/selectionId'

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
 * Expand an indexed mesh into the triangle soup the ID layers register: one
 * triangle is three unique vertices, so a per-triangle colour can carry a face
 * id. Both the part editor's face registration and the assembly's pick geometry
 * feed the same layer, so they must agree on this layout.
 */
export function toNonIndexedPositions(positions: Float32Array, indices: Uint32Array): Float32Array {
  const out = new Float32Array(indices.length * 3)
  for (let i = 0; i < indices.length; i++) {
    const vi = indices[i] * 3
    out[i * 3]     = positions[vi]
    out[i * 3 + 1] = positions[vi + 1]
    out[i * 3 + 2] = positions[vi + 2]
  }
  return out
}

export function getFaceIndices(faces: Mesh3D['faces'], i: number): [number, number, number] {
  if (faces instanceof Uint32Array) {
    return [faces[i * 3], faces[i * 3 + 1], faces[i * 3 + 2]]
  }
  return faces[i]
}

export function getVertex(vertices: Mesh3D['vertices'], vi: number): [number, number, number] {
  if (vertices instanceof Float32Array) {
    return [vertices[vi * 3], vertices[vi * 3 + 1], vertices[vi * 3 + 2]]
  }
  return vertices[vi]
}

export function faceCount(faces: Mesh3D['faces']): number {
  if (faces instanceof Uint32Array) return faces.length / 3
  return faces.length
}

export function vertexCount(vertices: Mesh3D['vertices']): number {
  if (vertices instanceof Float32Array) return vertices.length / 3
  return vertices.length
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
 * Triangle indices of the mesh grouped by the B-rep face they belong to, in one
 * pass. Pass the result to the per-face helpers below: without it each of them
 * scans the WHOLE triangle list to find its face's triangles, so asking for
 * every face costs O(faces x triangles). That quadratic was minutes of frozen UI
 * on an imported assembly (5000 faces / 100k triangles: 575 ms per body, and it
 * ran once per body before the first frame could paint).
 */
export function groupTrianglesByFace(mesh: Mesh3D): Map<number, number[]> | null {
  const { faces, triangle_to_face } = mesh
  if (!triangle_to_face) return null
  const groups = new Map<number, number[]>()
  const numTris = faceCount(faces)
  for (let i = 0; i < numTris; i++) {
    const f = triangle_to_face[i]
    if (f === undefined) continue
    const list = groups.get(f)
    if (list) list.push(i)
    else groups.set(f, [i])
  }
  return groups
}

const NO_TRIANGLES: readonly number[] = Object.freeze([])

export interface FaceTriangleLookup {
  /** This face's triangle indices; undefined when the mesh has no
   *  `triangle_to_face` at all (the callers below then take their own no-op path). */
  get(brepFaceIndex: number): readonly number[] | undefined
}

/**
 * `groupTrianglesByFace` deferred to the first face that actually asks. A body is
 * meshed and mounted far more often than any one of its faces is pointed at, so
 * this keeps the grouping out of the solve-to-first-frame path while still
 * paying for it only once per mesh.
 */
export function lazyFaceTriangles(mesh: Mesh3D): FaceTriangleLookup {
  let groups: Map<number, number[]> | null | undefined
  return {
    get(brepFaceIndex: number): readonly number[] | undefined {
      if (groups === undefined) groups = groupTrianglesByFace(mesh)
      if (!groups) return undefined
      // A face with no triangles answers with an empty list, never `undefined`:
      // undefined would send the caller back to a full-mesh scan for nothing.
      return groups.get(brepFaceIndex) ?? NO_TRIANGLES
    },
  }
}

/** Triangles of one face, found by scanning. The fallback when the caller has no
 *  grouping; O(triangles) per call, which is why asking for every face wants
 *  `groupTrianglesByFace` instead. */
function collectFaceTriangles(mesh: Mesh3D, brepFaceIndex: number): number[] {
  const { faces, triangle_to_face } = mesh
  const out: number[] = []
  if (!triangle_to_face) return out
  const numTris = faceCount(faces)
  for (let i = 0; i < numTris; i++) {
    if (triangle_to_face[i] === brepFaceIndex) out.push(i)
  }
  return out
}

// Return line segment positions for the outer boundary of one B-rep face.
// Uses the original indexed mesh: edges shared by two triangles within the same
// face are interior tessellation edges; edges appearing once are on the boundary.
// `triangles` is this face's triangle list from groupTrianglesByFace; omit it and
// the mesh gets scanned for them.
export function buildFaceBoundarySegments(
  mesh: Mesh3D,
  brepFaceIndex: number,
  triangles?: readonly number[],
): Float32Array {
  const { faces, vertices, triangle_to_face } = mesh
  if (!triangle_to_face) return new Float32Array(0)
  const tris = triangles ?? collectFaceTriangles(mesh, brepFaceIndex)
  if (tris.length === 0) return new Float32Array(0)

  // Undirected vertex pair as one number: lo * stride + hi. Exact (and so
  // collision-free) while stride squared stays inside 2^53, which holds for any
  // mesh that fits in memory. The former `${v1}:${v2}` string key allocated three
  // strings per triangle, and hashing them dominated the whole build.
  const stride = vertexCount(vertices)
  const pairKey = (v1: number, v2: number) => (v1 < v2 ? v1 * stride + v2 : v2 * stride + v1)

  const edgeCount = new Map<number, number>()
  const bump = (v1: number, v2: number) => {
    const key = pairKey(v1, v2)
    edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1)
  }
  for (const i of tris) {
    const [a, b, c] = getFaceIndices(faces, i)
    bump(a, b); bump(b, c); bump(c, a)
  }

  // Second pass over the same triangles rather than a parallel key -> pair map: a
  // boundary edge occurs exactly once, so walking the triangles again emits each
  // one once, in the same first-encounter order the map iteration produced.
  const pts: number[] = []
  for (const i of tris) {
    const [a, b, c] = getFaceIndices(faces, i)
    for (const [v1, v2] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      if (edgeCount.get(pairKey(v1, v2)) !== 1) continue
      pts.push(...getVertex(vertices, v1), ...getVertex(vertices, v2))
    }
  }
  return new Float32Array(pts)
}

// Extract unique vertices for a single B-rep face from the tessellated mesh.
export function extractFaceGeometry(
  mesh: Mesh3D,
  brepFaceIndex: number,
  triangles?: readonly number[],
): { vertices: [number, number, number][] } | null {
  const { faces, vertices, triangle_to_face } = mesh
  if (!triangle_to_face) return null

  const seen = new Set<number>()
  const faceVerts: [number, number, number][] = []

  for (const i of triangles ?? collectFaceTriangles(mesh, brepFaceIndex)) {
    for (const vi of getFaceIndices(faces, i)) {
      if (!seen.has(vi)) {
        seen.add(vi)
        faceVerts.push(getVertex(vertices, vi))
      }
    }
  }

  if (faceVerts.length < 3) return null
  return { vertices: faceVerts }
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
          || Number.isNaN(angle_start) || Number.isNaN(angle_end)) {
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
          || Number.isNaN(angle_start) || Number.isNaN(angle_end)) {
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

  return { positions: new Float32Array(parts), segmentToEdge: new Uint32Array(owners) }
}

// Build a flat Float32Array of line segment endpoints from edge descriptors.
// Each segment contributes 6 floats: [x0,y0,z0, x1,y1,z1].
export function buildEdgeSegments(edges: EdgeData[]): Float32Array {
  return buildEdgeSegmentGeometry(edges).positions
}

// Get the number of line segments each edge produces.
// Used to map from raycasted segment index back to edge index for the VISIBLE
// line pass. Counts unconditionally, so it disagrees with the built positions
// whenever an edge is skipped; ID registration must use buildEdgeSegmentGeometry,
// whose map shares the builder's skip conditions.
export function getEdgeSegmentCounts(edges: EdgeData[]): number[] {
  const counts: number[] = []
  for (const edge of edges) {
    if (edge.kind === 'line') {
      counts.push(1)
    } else if (edge.kind === 'circle' || edge.kind === 'arc') {
      const sweep = edge.angle_end - edge.angle_start
      const segs = Math.max(2, Math.round(ARC_SEGMENTS * Math.abs(sweep) / (2 * Math.PI)))
      counts.push(segs)
    } else if (edge.kind === 'spline') {
      counts.push(Math.max(0, edge.points.length - 1))
    } else if (edge.kind === 'ellipse') {
      const sweep = edge.angle_end - edge.angle_start
      counts.push(Math.max(2, Math.round(ARC_SEGMENTS * Math.abs(sweep) / (2 * Math.PI))))
    }
  }
  return counts
}
