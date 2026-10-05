// PURE LOGIC -- no Three.js, no React refs.
// The triangle-soup and per-face boundary helpers shared by the part editor's
// body registration and the assembly's ID pick geometry. Re-homed here so
// `utils/assemblyPick.ts` does not import across the UI boundary into
// `components/Geometry3D/bodyGeometry`.
import type { Mesh3D } from '@/types/cad'

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

function getFaceIndices(faces: Mesh3D['faces'], i: number): [number, number, number] {
  if (faces instanceof Uint32Array) {
    return [faces[i * 3], faces[i * 3 + 1], faces[i * 3 + 2]]
  }
  return faces[i]
}

function getVertex(vertices: Mesh3D['vertices'], vi: number): [number, number, number] {
  if (vertices instanceof Float32Array) {
    return [vertices[vi * 3], vertices[vi * 3 + 1], vertices[vi * 3 + 2]]
  }
  return vertices[vi]
}

export function faceCount(faces: Mesh3D['faces']): number {
  if (faces instanceof Uint32Array) return faces.length / 3
  return faces.length
}

function vertexCount(vertices: Mesh3D['vertices']): number {
  if (vertices instanceof Float32Array) return vertices.length / 3
  return vertices.length
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
