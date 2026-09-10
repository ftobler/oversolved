// The ID-buffer geometry of an assembly scene, computed without a viewport.
//
// The part editor's Body3D registers its layers from `BodyResult` queries. An
// assembly has no queries: its entities are named positionally by the bundle
// (`assemblyEntityKey`), and the anchors they offer come from `entityAnchors`.
// So the registration payloads are built here, from the solved mesh payloads,
// and a thin component hands them to the pipeline.
//
// Every face, edge and vertex is registered, matable or not. A hit on an
// anchor-less entity must resolve to an empty candidate set (Stage 7's
// contract), and it can only do that if the entity has a pick id at all.

import { buildFaceBoundarySegments, lazyFaceTriangles, toNonIndexedPositions } from '@/components/Geometry3D/bodyGeometry'
import type { MeshPayload } from '@/kernel/solveAssembly'
import { assemblyEntityKey } from '@/utils/anchorCandidates'
import { assemblyBodyId } from '@/utils/assemblyBodies'
import type { AnchorTable } from '@/utils/anchorGizmos'
import type { Mesh3D, Transform3D } from '@/types/cad'
import { buildIndexedCurveSegments } from '@/utils/edgeSampling'
import {
  relativeTransform,
  rotateVector,
  transformQuat,
  type Vec3,
} from '@/utils/transform3d'

export interface AssemblyPickBody {
  // The part instance this body belongs to; the offsetter keys its pose by it.
  handle: string
  // Registration key for all three layers; `assemblyBodyId` already scopes it by part.
  bodyKey: string
  faces: { positions: Float32Array; triangleToFace: Uint32Array; faceQueries: string[] } | null
  edges: { segmentPositions: Float32Array; segmentToEdge: Uint32Array; edgeQueries: string[] } | null
  vertices: { vertices: Vec3[]; vertexQueries: string[] } | null
  /** Per-face boundary-loop segments (6 floats per segment), keyed by face index.
   *  Absent for a face that produced no closed loop (degenerate/open tessellation). */
  faceBoundaries: Map<number, Float32Array> | null
}

function faceCount(m: MeshPayload): number {
  let maxId = -1
  for (let i = 0; i < m.faceIdsPerTriangle.length; i++) {
    if (m.faceIdsPerTriangle[i] > maxId) maxId = m.faceIdsPerTriangle[i]
  }
  // `entityAnchors` is authoritative when present: a trailing face carrying no
  // triangles still owns an entity slot, and dropping it would shift nothing
  // but would leave that face unpickable.
  return Math.max(maxId + 1, m.entityAnchors?.faces.length ?? 0)
}

function buildFaces(handle: string, bodyIndex: number, m: MeshPayload): AssemblyPickBody['faces'] {
  if (m.indices.length === 0) return null
  const n = faceCount(m)
  if (n === 0) return null
  const faceQueries: string[] = []
  for (let i = 0; i < n; i++) faceQueries.push(assemblyEntityKey(handle, bodyIndex, 'face', i))
  return {
    positions: toNonIndexedPositions(m.vertices, m.indices),
    triangleToFace: m.faceIdsPerTriangle,
    faceQueries,
  }
}

/**
 * Part editor's boundary-loop algorithm (`buildFaceBoundarySegments`) needs the
 * original indexed mesh: an edge shared by exactly one triangle within a face is
 * on that face's boundary, and that count only works before the mesh gets
 * flattened into the non-indexed triangle soup `buildFaces` produces. So this
 * runs on the raw `MeshPayload`, ahead of that flattening, wrapped in a shim
 * matching the `Mesh3D` shape the shared algorithm expects.
 */
function buildFaceBoundaries(m: MeshPayload): AssemblyPickBody['faceBoundaries'] {
  if (m.indices.length === 0) return null
  const n = faceCount(m)
  if (n === 0) return null
  const mesh: Mesh3D = {
    vertices: m.vertices,
    faces: m.indices,
    triangle_to_face: Array.from(m.faceIdsPerTriangle),
  }
  // One grouping pass, shared by every face. Without it each face re-scans the
  // whole triangle list to find its own triangles, making the loop
  // O(faces x triangles) -- the shape that froze the UI on an imported assembly.
  const triangles = lazyFaceTriangles(mesh)
  const boundaries = new Map<number, Float32Array>()
  for (let i = 0; i < n; i++) {
    const segments = buildFaceBoundarySegments(mesh, i, triangles.get(i))
    if (segments.length > 0) boundaries.set(i, segments)
  }
  return boundaries.size > 0 ? boundaries : null
}

function buildEdges(handle: string, bodyIndex: number, m: MeshPayload): AssemblyPickBody['edges'] {
  const curves = m.edges ?? []
  if (curves.length === 0) return null
  const { positions, segmentToCurve } = buildIndexedCurveSegments(curves)
  if (positions.length === 0) return null
  return {
    segmentPositions: positions,
    segmentToEdge: segmentToCurve,
    edgeQueries: curves.map((_, i) => assemblyEntityKey(handle, bodyIndex, 'edge', i)),
  }
}

/**
 * Vertex positions come from the anchor table, not from the mesh: the bundle
 * never ships a B-rep vertex list, and a vertex anchor's `point` IS the vertex,
 * already carried into the solved pose. A vertex the extractor skipped has no
 * anchor and therefore no position, so it gets no pick id. It could not have
 * been mated anyway.
 */
function buildVertices(
  handle: string, bodyIndex: number, m: MeshPayload, anchors: Readonly<AnchorTable>,
): AssemblyPickBody['vertices'] {
  const slots = m.entityAnchors?.vertices
  if (!slots || slots.length === 0) return null
  const partAnchors = anchors[handle] ?? {}
  const vertices: Vec3[] = []
  const vertexQueries: string[] = []
  slots.forEach((anchorIds, index) => {
    const anchor = anchorIds.length > 0 ? partAnchors[anchorIds[0]] : undefined
    if (!anchor) return
    vertices.push([...anchor.point] as Vec3)
    vertexQueries.push(assemblyEntityKey(handle, bodyIndex, 'vertex', index))
  })
  if (vertices.length === 0) return null
  return { vertices, vertexQueries }
}

/** One registration payload per body of every part instance, in handle order. */
export function buildPickBodies(
  bodies: Record<string, MeshPayload[]>,
  anchors: Readonly<AnchorTable>,
): AssemblyPickBody[] {
  const out: AssemblyPickBody[] = []
  for (const [handle, meshes] of Object.entries(bodies)) {
    meshes.forEach((m, bodyIndex) => {
      out.push({
        handle,
        bodyKey: assemblyBodyId(handle, bodyIndex),
        faces: buildFaces(handle, bodyIndex, m),
        edges: buildEdges(handle, bodyIndex, m),
        vertices: buildVertices(handle, bodyIndex, m, anchors),
        faceBoundaries: buildFaceBoundaries(m),
      })
    })
  }
  return out
}

function offsetPositions(positions: Float32Array, t: Transform3D): Float32Array {
  const q = transformQuat(t)
  const out = new Float32Array(positions.length)
  for (let i = 0; i < positions.length; i += 3) {
    const r = rotateVector(q, [positions[i], positions[i + 1], positions[i + 2]])
    out[i] = r[0] + t.tx
    out[i + 1] = r[1] + t.ty
    out[i + 2] = r[2] + t.tz
  }
  return out
}

function offsetPoints(points: readonly Vec3[], t: Transform3D): Vec3[] {
  const q = transformQuat(t)
  return points.map(p => {
    const r = rotateVector(q, p)
    return [r[0] + t.tx, r[1] + t.ty, r[2] + t.tz] as Vec3
  })
}

function offsetBody(body: AssemblyPickBody, t: Transform3D): AssemblyPickBody {
  return {
    ...body,
    faces: body.faces ? { ...body.faces, positions: offsetPositions(body.faces.positions, t) } : null,
    edges: body.edges ? { ...body.edges, segmentPositions: offsetPositions(body.edges.segmentPositions, t) } : null,
    vertices: body.vertices ? { ...body.vertices, vertices: offsetPoints(body.vertices.vertices, t) } : null,
    faceBoundaries: body.faceBoundaries
      ? new Map([...body.faceBoundaries].map(([index, segs]) => [index, offsetPositions(segs, t)]))
      : null,
  }
}

// A pick snapshot is point/segment soup: a difference this small can never flip
// which primitive a pixel resolves to, so it is the same drawn placement. Kept
// separate from transformsEqual, whose 1 - eps^2 rounds to 1 in double precision
// and therefore demands a bit-exact dot product for a composed identity -- the
// at-rest case this short-circuit exists to catch.
const IDENTITY_OFFSET_EPS = 1e-6

function isIdentityOffset(t: Transform3D): boolean {
  return (
    Math.abs(t.tx) <= IDENTITY_OFFSET_EPS &&
    Math.abs(t.ty) <= IDENTITY_OFFSET_EPS &&
    Math.abs(t.tz) <= IDENTITY_OFFSET_EPS &&
    // qw = +/-1 with the vector part small is a rotation by a negligible angle;
    // the absolute value covers the quaternion double cover.
    Math.abs(1 - Math.abs(t.qw)) <= IDENTITY_OFFSET_EPS
  )
}

/**
 * Translate a baked pick snapshot onto the drawn pose. Each body carries its
 * instance handle; its offset is the drawn pose relative to the pose the
 * snapshot was baked at. Bodies already at their drawn pose are returned by
 * reference, so a settle re-registers only the parts that actually moved.
 */
export function offsetPickBodies(
  pickBodies: readonly AssemblyPickBody[],
  bakedPose: Readonly<Record<string, Transform3D>>,
  drawnPoses: Readonly<Record<string, Transform3D>>,
): AssemblyPickBody[] {
  return pickBodies.map(body => {
    const baked = bakedPose[body.handle]
    const drawn = drawnPoses[body.handle]
    if (!baked || !drawn) return body
    const offset = relativeTransform(drawn, baked)
    if (isIdentityOffset(offset)) return body
    return offsetBody(body, offset)
  })
}
