import { describe, it, expect } from 'vitest'
import { unpackBodies, unpackPickBodies } from '../geometryUnpack'
import type { GeometryHeader } from '../geometryUnpack'

function buildBinaryFrame(
  header: GeometryHeader,
  binaryData: Uint8Array,
): { buffer: ArrayBuffer; jsonHeaderLen: number } {
  const headerStr = JSON.stringify(header)
  const headerBytes = new TextEncoder().encode(headerStr)
  const paddedLen = Math.ceil(headerBytes.length / 4) * 4
  const padded = new Uint8Array(paddedLen)
  padded.set(headerBytes)

  const totalLen = 4 + paddedLen + binaryData.byteLength
  const buf = new ArrayBuffer(totalLen)
  const view = new DataView(buf)
  view.setUint32(0, paddedLen)
  new Uint8Array(buf, 4, paddedLen).set(padded)
  new Uint8Array(buf, 4 + paddedLen).set(binaryData)

  return { buffer: buf, jsonHeaderLen: paddedLen }
}

describe('unpackBodies', () => {
  it('returns empty record when header has no bodies', () => {
    const header: GeometryHeader = { msgId: 1, bodies: {} }
    const { buffer, jsonHeaderLen } = buildBinaryFrame(header, new Uint8Array(0))
    const result = unpackBodies(header, buffer, jsonHeaderLen)
    expect(Object.keys(result)).toHaveLength(0)
  })

  it('creates Float32Array for vertices and Uint32Array for faces', () => {
    const verts = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const faces = new Uint32Array([0, 1, 2])
    const tri2face = new Uint32Array([5])

    const binary = new Uint8Array(verts.byteLength + faces.byteLength + tri2face.byteLength)
    binary.set(new Uint8Array(verts.buffer), 0)
    binary.set(new Uint8Array(faces.buffer), verts.byteLength)
    binary.set(new Uint8Array(tri2face.buffer), verts.byteLength + faces.byteLength)

    const header: GeometryHeader = {
      msgId: 2,
      bodies: {
        body_0: {
          created_by: 'extrude_0',
          modified_by: [],
          face_data: [],
          face_queries: ['@extrude_0/face0'],
          edges: [],
          edge_queries: [],
          brep_vertex_queries: [],
          vertices: [],
          offsets: {
            vertices: [0, verts.byteLength],
            faces: [verts.byteLength, faces.byteLength],
            tri2face: [verts.byteLength + faces.byteLength, tri2face.byteLength],
          },
          counts: {
            vertices: 3,
            faces: 1,
            tri2face: 1,
          },
        },
      },
    }

    const { buffer, jsonHeaderLen } = buildBinaryFrame(header, binary)
    const result = unpackBodies(header, buffer, jsonHeaderLen)

    expect(Object.keys(result)).toEqual(['body_0'])
    const body = result['body_0']
    expect(body.mesh?.vertices).toBeInstanceOf(Float32Array)
    expect(body.mesh?.faces).toBeInstanceOf(Uint32Array)
    const v = body.mesh?.vertices as Float32Array
    expect(Array.from(v)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const f = body.mesh?.faces as Uint32Array
    expect(Array.from(f)).toEqual([0, 1, 2])
    expect(body.mesh?.triangle_to_face).toEqual([5])
    expect(body.mesh?.face_queries).toEqual(['@extrude_0/face0'])
    expect(body.created_by).toBe('extrude_0')
  })

  it('handles empty vertex/face buffers gracefully', () => {
    const header: GeometryHeader = {
      msgId: 3,
      bodies: {
        empty_body: {
          created_by: 'sketch_0',
          modified_by: [],
          face_data: [],
          face_queries: [],
          edges: [],
          edge_queries: [],
          brep_vertex_queries: [],
          vertices: [],
          offsets: {
            vertices: [0, 0],
            faces: [0, 0],
            tri2face: [0, 0],
          },
          counts: {
            vertices: 0,
            faces: 0,
            tri2face: 0,
          },
        },
      },
    }
    const { buffer: buf, jsonHeaderLen } = buildBinaryFrame(header, new Uint8Array(0))
    const result = unpackBodies(header, buf, jsonHeaderLen)
    const body = result['empty_body']
    expect(body.mesh?.vertices).toBeInstanceOf(Float32Array)
    expect((body.mesh?.vertices as Float32Array).length).toBe(0)
  })

  it('unpacks pick_bodies separately', () => {
    const verts = new Float32Array([0, 0, 0])
    const binary = new Uint8Array(verts.byteLength)
    binary.set(new Uint8Array(verts.buffer))

    const header: GeometryHeader = {
      msgId: 4,
      bodies: {},
      pick_bodies: {
        pick_0: {
          created_by: 'extrude_0',
          modified_by: [],
          face_data: [],
          face_queries: [],
          edges: [],
          edge_queries: [],
          brep_vertex_queries: [],
          vertices: [],
          offsets: {
            vertices: [0, verts.byteLength],
            faces: [verts.byteLength, 0],
            tri2face: [verts.byteLength, 0],
          },
          counts: {
            vertices: 1,
            faces: 0,
            tri2face: 0,
          },
        },
      },
    }

    const { buffer, jsonHeaderLen } = buildBinaryFrame(header, binary)
    const result = unpackPickBodies(header, buffer, jsonHeaderLen)
    expect(Object.keys(result)).toEqual(['pick_0'])
    expect(result['pick_0'].mesh?.vertices).toBeInstanceOf(Float32Array)
  })
})
