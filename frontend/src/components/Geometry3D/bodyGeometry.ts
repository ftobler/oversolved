import type { Mesh3D, EdgeData } from '../../types/cad'
import { ARC_SEGMENTS } from './constants'

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

export function _getFaceIndices(faces: Mesh3D['faces'], i: number): [number, number, number] {
  if (faces instanceof Uint32Array) {
    return [faces[i * 3], faces[i * 3 + 1], faces[i * 3 + 2]]
  }
  return faces[i]
}

export function _getVertex(vertices: Mesh3D['vertices'], vi: number): [number, number, number] {
  if (vertices instanceof Float32Array) {
    return [vertices[vi * 3], vertices[vi * 3 + 1], vertices[vi * 3 + 2]]
  }
  return vertices[vi]
}

export function _faceCount(faces: Mesh3D['faces']): number {
  if (faces instanceof Uint32Array) return faces.length / 3
  return faces.length
}

// Return line segment positions for the outer boundary of one B-rep face.
// Uses the original indexed mesh: edges shared by two triangles within the same
// face are interior tessellation edges; edges appearing once are on the boundary.
export function buildFaceBoundarySegments(mesh: Mesh3D, brepFaceIndex: number): Float32Array {
  const { faces, vertices, triangle_to_face } = mesh
  if (!triangle_to_face) return new Float32Array(0)

  const edgeCount = new Map<string, number>()
  const edgeVerts = new Map<string, [number, number]>()

  const numFaces = _faceCount(faces)
  for (let i = 0; i < numFaces; i++) {
    if (triangle_to_face[i] !== brepFaceIndex) continue
    const [a, b, c] = _getFaceIndices(faces, i)
    for (const [v1, v2] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      const key = v1 < v2 ? `${v1}:${v2}` : `${v2}:${v1}`
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1)
      if (!edgeVerts.has(key)) edgeVerts.set(key, [v1, v2])
    }
  }

  const pts: number[] = []
  for (const [key, count] of edgeCount) {
    if (count === 1) {
      const [v1, v2] = edgeVerts.get(key)!
      pts.push(..._getVertex(vertices, v1), ..._getVertex(vertices, v2))
    }
  }
  return new Float32Array(pts)
}

// Extract unique vertices for a single B-rep face from the tessellated mesh.
export function extractFaceGeometry(mesh: Mesh3D, brepFaceIndex: number): { vertices: [number, number, number][] } | null {
  const { faces, vertices, triangle_to_face } = mesh
  if (!triangle_to_face) return null

  const seen = new Set<number>()
  const faceVerts: [number, number, number][] = []

  const numFaces = _faceCount(faces)
  for (let i = 0; i < numFaces; i++) {
    if (triangle_to_face[i] !== brepFaceIndex) continue
    for (const vi of _getFaceIndices(faces, i)) {
      if (!seen.has(vi)) {
        seen.add(vi)
        faceVerts.push(_getVertex(vertices, vi))
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

// Build a flat Float32Array of line segment endpoints from edge descriptors.
// Each segment contributes 6 floats: [x0,y0,z0, x1,y1,z1].
export function buildEdgeSegments(edges: EdgeData[]): Float32Array {
  const parts: number[] = []

  for (const edge of edges) {
    if (edge.kind === 'line') {
      if (_isValidSegment(edge.start) && _isValidSegment(edge.end)) {
        parts.push(...edge.start, ...edge.end)
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
        prevX = nx; prevY = ny; prevZ = nz
      }
    } else if (edge.kind === 'spline') {
      const pts = edge.points
      for (let i = 0; i < pts.length - 1; i++) {
        if (_isValidSegment(pts[i]) && _isValidSegment(pts[i + 1])) {
          parts.push(...pts[i], ...pts[i + 1])
        }
      }
    }
  }

  return new Float32Array(parts)
}

// Get the number of line segments each edge produces.
// Used to map from raycasted segment index back to edge index.
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
    }
  }
  return counts
}
