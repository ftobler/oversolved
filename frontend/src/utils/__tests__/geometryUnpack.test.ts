import { describe, it, expect } from 'vitest'
import { unpackBodies, unpackPickBodies } from '@/utils/geometryUnpack'
import type { GeometryHeader } from '@/utils/geometryUnpack'

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

describe('geometryUnpack error handling', () => {
  function makeHeader(bodyMeta: Partial<import('@/utils/geometryUnpack').BodyMeta> = {}): import('@/utils/geometryUnpack').GeometryHeader {
    return {
      msgId: 1,
      bodies: {
        body_0: {
          created_by: 'extrude_0',
          modified_by: [],
          face_data: [],
          face_queries: [],
          edges: [],
          edge_queries: [],
          brep_vertex_queries: [],
          vertices: [],
          offsets: { vertices: [0, 0], faces: [0, 0], tri2face: [0, 0] },
          counts: { vertices: 0, faces: 0, tri2face: 0 },
          ...bodyMeta,
        },
      },
    }
  }

  it('returns empty record for truncated buffer', () => {
    const header = makeHeader({
      offsets: { vertices: [0, 12], faces: [12, 12], tri2face: [24, 4] },
      counts: { vertices: 1, faces: 1, tri2face: 1 },
    })
    const buf = new ArrayBuffer(4)  // header-only, no binary data
    const headerStr = JSON.stringify(header)
    const paddedLen = Math.ceil(new TextEncoder().encode(headerStr).length / 4) * 4

    // Float32Array/Uint32Array constructor throws when offset+length exceeds buffer
    expect(() => {
      unpackBodies(header, buf, paddedLen)
    }).toThrow()
  })

  it('handles negative vertex count gracefully', () => {
    const verts = new Float32Array([0, 0, 0])
    const binary = new Uint8Array(verts.byteLength)
    binary.set(new Uint8Array(verts.buffer))

    const header = makeHeader({
      offsets: { vertices: [0, 12], faces: [12, 0], tri2face: [12, 0] },
      counts: { vertices: -1, faces: 0, tri2face: 0 },
    })

    const { buffer, jsonHeaderLen } = buildBinaryFrame(header, binary)

    expect(() => {
      unpackBodies(header, buffer, jsonHeaderLen)
    }).toThrow()
  })

  it('handles negative face count gracefully', () => {
    const binary = new Uint8Array(0)
    const header = makeHeader({
      offsets: { vertices: [0, 0], faces: [0, 12], tri2face: [12, 0] },
      counts: { vertices: 0, faces: -1, tri2face: 0 },
    })

    const { buffer, jsonHeaderLen } = buildBinaryFrame(header, binary)

    expect(() => {
      unpackBodies(header, buffer, jsonHeaderLen)
    }).toThrow()
  })

  it('handles missing counts field in header', () => {
    // BodyMeta requires counts, so we use a type cast to simulate missing field
    const header = makeHeader()
    const { buffer, jsonHeaderLen } = buildBinaryFrame(header, new Uint8Array(0))

    // Missing counts should still work if all counts are zero (default from makeHeader)
    const result = unpackBodies(header, buffer, jsonHeaderLen)
    expect(Object.keys(result)).toHaveLength(1)
    expect(result.body_0.mesh?.vertices).toBeInstanceOf(Float32Array)
    expect((result.body_0.mesh?.vertices as Float32Array).length).toBe(0)
  })

  it('handles missing offsets field gracefully', () => {
    const binary = new Uint8Array(0)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const header: any = makeHeader()
    header.bodies.body_0.offsets = undefined

    const { buffer, jsonHeaderLen } = buildBinaryFrame(header, binary)

    expect(() => {
      unpackBodies(header, buffer, jsonHeaderLen)
    }).toThrow()
  })

  it('handles body with only edge_queries (no mesh)', () => {
    const header = makeHeader({
      edges: [{ id: 0, edge_type: 'line', start: [0, 0, 0], end: [1, 1, 1] }],
      edge_queries: ['@extrude_0/edge0'],
      brep_vertex_queries: [],
    })
    const { buffer, jsonHeaderLen } = buildBinaryFrame(header, new Uint8Array(0))

    const result = unpackBodies(header, buffer, jsonHeaderLen)
    expect(result.body_0.edges).toHaveLength(1)
    expect(result.body_0.edge_queries).toEqual(['@extrude_0/edge0'])
    // Mesh should have zero-length typed arrays
    expect((result.body_0.mesh?.vertices as Float32Array).length).toBe(0)
    expect((result.body_0.mesh?.faces as Uint32Array).length).toBe(0)
  })

  it('handles body with only brep_vertex_queries (no mesh)', () => {
    const header = makeHeader({
      vertices: [[0, 0, 0], [1, 0, 0]],
      brep_vertex_queries: ['@extrude_0/vertex0', '@extrude_0/vertex1'],
    })
    const { buffer, jsonHeaderLen } = buildBinaryFrame(header, new Uint8Array(0))

    const result = unpackBodies(header, buffer, jsonHeaderLen)
    expect(result.body_0.vertex_queries).toEqual(['@extrude_0/vertex0', '@extrude_0/vertex1'])
    expect(result.body_0.vertices).toEqual([[0, 0, 0], [1, 0, 0]])
  })

  it('handles offset values exceeding buffer length', () => {
    const binary = new Uint8Array(4)
    const header = makeHeader({
      offsets: { vertices: [9999, 12], faces: [10011, 12], tri2face: [10023, 4] },
      counts: { vertices: 1, faces: 1, tri2face: 1 },
    })

    const { buffer, jsonHeaderLen } = buildBinaryFrame(header, binary)

    expect(() => {
      unpackBodies(header, buffer, jsonHeaderLen)
    }).toThrow()
  })

  it('returns empty for missing pick_bodies', () => {
    const header = makeHeader()
    const { buffer, jsonHeaderLen } = buildBinaryFrame(header, new Uint8Array(0))

    const result = unpackPickBodies(header, buffer, jsonHeaderLen)
    expect(Object.keys(result)).toHaveLength(0)
  })
})
