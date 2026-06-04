/**
 * Port of `geometry_pack.py`: pack tessellated bodies into the binary frame the
 * viewport decodes (`utils/geometryUnpack.ts`).
 *
 * In the daemon world this packed a WebSocket frame; post-migration it is the
 * in-process builder -> viewport hand-off. The wire layout is unchanged so the
 * existing decoder consumes it verbatim:
 *
 *   [4B big-endian padded JSON header length]
 *   [UTF-8 JSON header, zero-padded to a 4-byte boundary]
 *   [binary data: per body, float32 vertices ++ uint32 faces ++ uint32 tri2face]
 *
 * Header offsets/counts are relative to the start of the binary section. The
 * binary section is byte-identical to Python's (IEEE-754 float32 / uint32, LE
 * on every platform the app targets, matching Python's `array('f'/'I')`). The
 * JSON header is structurally identical but not necessarily byte-identical:
 * Python's `json.dumps` and JS's `JSON.stringify` format floats differently
 * (e.g. `1.0` vs `1`), which is irrelevant since the consumer parses the JSON.
 */

import type { FaceData, EdgeData } from '@/types/cad'

export interface PackMesh {
  vertices: number[][] | Float32Array
  faces: number[][] | Uint32Array
  triangle_to_face?: number[]
  face_data?: FaceData[]
  face_queries?: string[]
}

export interface PackBody {
  created_by?: string | null
  modified_by?: string[]
  mesh?: PackMesh
  edges?: EdgeData[]
  edge_queries?: string[]
  vertices?: number[][]
  vertex_queries?: string[]
}

interface BinaryOffsets {
  vertices: [number, number]
  faces: [number, number]
  tri2face: [number, number]
}

interface PackedBodyHeader {
  created_by: string | null
  modified_by: string[]
  face_data: FaceData[]
  face_queries: string[]
  edges: EdgeData[]
  edge_queries: string[]
  brep_vertex_queries: string[]
  vertices: number[][]
  offsets: BinaryOffsets
  counts: { vertices: number; faces: number; tri2face: number }
}

interface GeometryHeaderOut {
  msgId: number | string
  bodies: Record<string, PackedBodyHeader>
  pick_bodies: Record<string, PackedBodyHeader>
  request_id?: number | string
}

function flatVerts(verts: number[][] | Float32Array): { flat: Float32Array; count: number } {
  if (verts instanceof Float32Array) {
    return { flat: verts, count: verts.length / 3 }
  }
  const flat = new Float32Array(verts.length * 3)
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i]
    if (v.length !== 3) {
      throw new Error(`vertex ${i} has ${v.length} components, expected 3`)
    }
    flat[i * 3] = v[0]
    flat[i * 3 + 1] = v[1]
    flat[i * 3 + 2] = v[2]
  }
  return { flat, count: verts.length }
}

function flatFaces(faces: number[][] | Uint32Array): { flat: Uint32Array; count: number } {
  if (faces instanceof Uint32Array) {
    return { flat: faces, count: faces.length / 3 }
  }
  const flat = new Uint32Array(faces.length * 3)
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i]
    flat[i * 3] = f[0]
    flat[i * 3 + 1] = f[1]
    flat[i * 3 + 2] = f[2]
  }
  return { flat, count: faces.length }
}

interface BodySection {
  header: PackedBodyHeader
  verts: Uint8Array
  faces: Uint8Array
  tri2face: Uint8Array
}

function packBodySection(body: PackBody, bodyOffset: number): { section: BodySection; nextOffset: number } {
  const mesh: PackMesh = body.mesh ?? { vertices: [], faces: [] }
  const { flat: vFlat, count: vertCount } = flatVerts(mesh.vertices ?? [])
  const { flat: fFlat, count: faceCount } = flatFaces(mesh.faces ?? [])
  const tri2faceArr = Uint32Array.from(mesh.triangle_to_face ?? [])

  // u8 views over the typed arrays' bytes (LE), matching Python's array().tobytes().
  const verts = new Uint8Array(vFlat.buffer, vFlat.byteOffset, vFlat.byteLength)
  const faces = new Uint8Array(fFlat.buffer, fFlat.byteOffset, fFlat.byteLength)
  const tri2face = new Uint8Array(tri2faceArr.buffer, tri2faceArr.byteOffset, tri2faceArr.byteLength)

  const vLen = verts.byteLength
  const fLen = faces.byteLength
  const tLen = tri2face.byteLength

  const header: PackedBodyHeader = {
    created_by: body.created_by ?? null,
    modified_by: body.modified_by ?? [],
    face_data: mesh.face_data ?? [],
    face_queries: mesh.face_queries ?? [],
    edges: body.edges ?? [],
    edge_queries: body.edge_queries ?? [],
    brep_vertex_queries: body.vertex_queries ?? [],
    vertices: body.vertices ?? [],
    offsets: {
      vertices: [bodyOffset, vLen],
      faces: [bodyOffset + vLen, fLen],
      tri2face: [bodyOffset + vLen + fLen, tLen],
    },
    counts: { vertices: vertCount, faces: faceCount, tri2face: tri2faceArr.length },
  }

  return { section: { header, verts, faces, tri2face }, nextOffset: bodyOffset + vLen + fLen + tLen }
}

export interface PackOptions {
  pickBodies?: Record<string, PackBody>
  requestId?: number | string
}

export function packGeometryUpdate(
  msgId: number | string,
  bodies: Record<string, PackBody> | null | undefined,
  opts: PackOptions = {},
): Uint8Array {
  const header: GeometryHeaderOut = { msgId, bodies: {}, pick_bodies: {} }
  if (opts.requestId !== undefined) header.request_id = opts.requestId

  const chunks: Uint8Array[] = []
  let bodyOffset = 0

  const packInto = (src: Record<string, PackBody>, dest: Record<string, PackedBodyHeader>) => {
    for (const [bodyId, body] of Object.entries(src)) {
      const { section, nextOffset } = packBodySection(body, bodyOffset)
      dest[bodyId] = section.header
      chunks.push(section.verts, section.faces, section.tri2face)
      bodyOffset = nextOffset
    }
  }

  packInto(bodies ?? {}, header.bodies)
  packInto(opts.pickBodies ?? {}, header.pick_bodies)

  const headerJson = JSON.stringify(header)
  const headerRaw = new TextEncoder().encode(headerJson)
  const paddedLen = Math.ceil(headerRaw.length / 4) * 4

  const binaryLen = chunks.reduce((n, c) => n + c.byteLength, 0)
  const frame = new Uint8Array(4 + paddedLen + binaryLen)
  new DataView(frame.buffer).setUint32(0, paddedLen, false) // big-endian, like struct.pack(">I")
  frame.set(headerRaw, 4)
  // bytes [4 + headerRaw.length, 4 + paddedLen) stay zero (the \x00 padding)

  let pos = 4 + paddedLen
  for (const chunk of chunks) {
    frame.set(chunk, pos)
    pos += chunk.byteLength
  }
  return frame
}
