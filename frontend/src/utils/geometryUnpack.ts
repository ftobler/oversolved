import type { BodyResult, FaceData } from '@/types/cad'

export interface BodyMeta {
  created_by: string
  modified_by: string[]
  face_data: FaceData[]
  face_queries: string[]
  edges: import('@/types/cad').EdgeData[]
  edge_queries: string[]
  brep_vertex_queries: string[]
  vertices: [number, number, number][]
  offsets: Record<string, [number, number]>
  counts: Record<string, number>
}

export interface GeometryHeader {
  msgId: number
  bodies: Record<string, BodyMeta>
  pick_bodies?: Record<string, BodyMeta>
}

function _unpackBodySection(
  meta: BodyMeta,
  bodyId: string,
  buffer: ArrayBuffer,
  dataStart: number,
): BodyResult {
  const [vOff, vLen] = meta.offsets.vertices
  const [fOff, fLen] = meta.offsets.faces
  const [tOff, tLen] = meta.offsets.tri2face

  const vertCount = meta.counts.vertices
  const faceCount = meta.counts.faces
  const tri2faceCount = meta.counts.tri2face

  // Zero-copy typed array views into the ArrayBuffer.
  const vertices = vLen > 0
    ? new Float32Array(buffer, dataStart + vOff, vertCount * 3)
    : new Float32Array(0)
  const faces = fLen > 0
    ? new Uint32Array(buffer, dataStart + fOff, faceCount * 3)
    : new Uint32Array(0)
  const triangleToFace = tLen > 0
    ? Array.from(new Uint32Array(buffer, dataStart + tOff, tri2faceCount))
    : undefined

  return {
    id: bodyId,
    created_by: meta.created_by,
    modified_by: meta.modified_by,
    mesh: {
      vertices,
      faces,
      face_data: meta.face_data,
      triangle_to_face: triangleToFace,
      face_queries: meta.face_queries,
    },
    edges: meta.edges,
    edge_queries: meta.edge_queries,
    vertices: meta.vertices,
    vertex_queries: meta.brep_vertex_queries,
  }
}

export function unpackBodies(
  header: GeometryHeader,
  buffer: ArrayBuffer,
  jsonHeaderLen: number,
): Record<string, BodyResult> {
  const dataStart = 4 + jsonHeaderLen
  const bodies: Record<string, BodyResult> = {}
  for (const [bodyId, meta] of Object.entries(header.bodies)) {
    bodies[bodyId] = _unpackBodySection(meta, bodyId, buffer, dataStart)
  }
  return bodies
}

export function unpackPickBodies(
  header: GeometryHeader,
  buffer: ArrayBuffer,
  jsonHeaderLen: number,
): Record<string, BodyResult> {
  if (!header.pick_bodies) return {}
  const dataStart = 4 + jsonHeaderLen
  const bodies: Record<string, BodyResult> = {}
  for (const [bodyId, meta] of Object.entries(header.pick_bodies)) {
    bodies[bodyId] = _unpackBodySection(meta, bodyId, buffer, dataStart)
  }
  return bodies
}
