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

import { toNonIndexedPositions } from '@/components/Geometry3D/bodyGeometry'
import type { MeshPayload } from '@/kernel/solveAssembly'
import { assemblyEntityKey } from '@/utils/anchorCandidates'
import { assemblyBodyId } from '@/utils/assemblyBodies'
import type { AnchorTable } from '@/utils/anchorGizmos'
import { buildIndexedCurveSegments } from '@/utils/edgeSampling'
import type { Vec3 } from '@/utils/transform3d'

export interface AssemblyPickBody {
  /** Registration key for all three layers; `assemblyBodyId` already scopes it by part. */
  bodyKey: string
  faces: { positions: Float32Array; triangleToFace: Uint32Array; faceQueries: string[] } | null
  edges: { segmentPositions: Float32Array; segmentToEdge: Uint32Array; edgeQueries: string[] } | null
  vertices: { vertices: Vec3[]; vertexQueries: string[] } | null
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
        bodyKey: assemblyBodyId(handle, bodyIndex),
        faces: buildFaces(handle, bodyIndex, m),
        edges: buildEdges(handle, bodyIndex, m),
        vertices: buildVertices(handle, bodyIndex, m, anchors),
      })
    })
  }
  return out
}
