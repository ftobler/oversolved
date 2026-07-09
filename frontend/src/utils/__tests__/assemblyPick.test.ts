// The ID-layer payloads the assembly scene registers. The invariant that matters
// is the positional join: a pick lands on a triangle or a segment, and the query
// it names must be the entity `entityAnchors` indexed anchors under.

import { describe, it, expect } from 'vitest'
import type { MeshPayload } from '@/kernel/solveAssembly'
import { assemblyEntityKey } from '@/utils/anchorCandidates'
import { buildAnchorTable, type AnchorTable } from '@/utils/anchorGizmos'
import { buildPickBodies } from '@/utils/assemblyPick'
import type { EdgeCurve } from '@/kernel/partBundle'

const PART = 'h1'

const LINE: EdgeCurve = {
  id: 'e0', kind: 'line', point: [5, 0, 0],
  endpoints: [[0, 0, 0], [10, 0, 0]],
}

const CIRCLE: EdgeCurve = {
  id: 'e1', kind: 'circle', point: [0, 0, 0], axis: [0, 0, 1], radius: 2,
  x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI * 2,
  endpoints: [[2, 0, 0], [2, 0, 0]],
}

/** Two triangles: face 0 gets the first, face 1 the second. */
function makeMesh(overrides?: Partial<MeshPayload>): MeshPayload {
  return {
    vertices: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 10, 10, 0]),
    indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
    faceIdsPerTriangle: new Uint32Array([0, 1]),
    edges: [LINE],
    entityAnchors: {
      faces: [['a_f0'], []],
      edges: [['a_e0']],
      vertices: [['a_v0'], ['a_v1']],
    },
    ...overrides,
  }
}

const ANCHORS: AnchorTable = buildAnchorTable({
  [PART]: {
    a_f0: { kind: 'plane', point: [3, 3, 0], axis: [0, 0, 1] },
    a_e0: { kind: 'line', point: [5, 0, 0], axis: [1, 0, 0] },
    a_v0: { kind: 'point', point: [0, 0, 0], axis: [0, 0, 1] },
    a_v1: { kind: 'point', point: [10, 0, 0], axis: [0, 0, 1] },
  },
})

function build(mesh: MeshPayload, anchors: AnchorTable = ANCHORS) {
  return buildPickBodies({ [PART]: [mesh] }, anchors)[0]
}

describe('buildPickBodies', () => {
  it('names one body per mesh, keyed the way the render list keys it', () => {
    const bodies = buildPickBodies({ [PART]: [makeMesh(), makeMesh()] }, ANCHORS)
    expect(bodies.map(b => b.bodyKey)).toEqual([`${PART}:body_0`, `${PART}:body_1`])
  })

  it('expands the index into a non-indexed triangle soup the face layer wants', () => {
    const { faces } = build(makeMesh())
    expect(faces!.positions.length).toBe(2 * 9)
    // Triangle 0 is vertices 0,1,2 of the indexed mesh.
    expect([...faces!.positions.slice(0, 9)]).toEqual([0, 0, 0, 10, 0, 0, 0, 10, 0])
  })

  it('gives every face a pick id, matable or not, so an anchor-less hit can resolve to nothing', () => {
    const { faces } = build(makeMesh())
    expect(faces!.faceQueries).toEqual([
      assemblyEntityKey(PART, 0, 'face', 0),
      assemblyEntityKey(PART, 0, 'face', 1),  // no anchor, still pickable
    ])
    expect([...faces!.triangleToFace]).toEqual([0, 1])
  })

  it('counts a face that owns no triangles, so it keeps its entity slot', () => {
    const mesh = makeMesh({
      faceIdsPerTriangle: new Uint32Array([0, 0]),
      entityAnchors: { faces: [['a_f0'], [], []], edges: [], vertices: [] },
    })
    expect(build(mesh).faces!.faceQueries).toHaveLength(3)
  })

  it('joins each sampled segment back to the curve that produced it', () => {
    const { edges } = build(makeMesh({ edges: [LINE, CIRCLE] }))
    expect(edges!.edgeQueries).toEqual([
      assemblyEntityKey(PART, 0, 'edge', 0),
      assemblyEntityKey(PART, 0, 'edge', 1),
    ])
    // A line is one segment; the full circle takes the default resolution.
    expect(edges!.segmentToEdge[0]).toBe(0)
    expect(edges!.segmentToEdge.filter(i => i === 0)).toHaveLength(1)
    expect(edges!.segmentToEdge.filter(i => i === 1)).toHaveLength(64)
    expect(edges!.segmentPositions.length).toBe(edges!.segmentToEdge.length * 6)
  })

  it('takes vertex positions from the anchor table, already in the solved pose', () => {
    const { vertices } = build(makeMesh())
    expect(vertices!.vertices).toEqual([[0, 0, 0], [10, 0, 0]])
    expect(vertices!.vertexQueries).toEqual([
      assemblyEntityKey(PART, 0, 'vertex', 0),
      assemblyEntityKey(PART, 0, 'vertex', 1),
    ])
  })

  it('skips a vertex with no anchor, keeping the surviving vertices on their own slots', () => {
    const mesh = makeMesh({
      entityAnchors: { faces: [], edges: [], vertices: [[], ['a_v1']] },
    })
    const { vertices } = build(mesh)
    expect(vertices!.vertices).toEqual([[10, 0, 0]])
    expect(vertices!.vertexQueries).toEqual([assemblyEntityKey(PART, 0, 'vertex', 1)])
  })

  it('offers no edge or vertex layer for a bundle cached before the entity index existed', () => {
    const body = build(makeMesh({ edges: [], entityAnchors: undefined }))
    expect(body.edges).toBeNull()
    expect(body.vertices).toBeNull()
    // Faces survive: their count comes from the triangle map, not the index.
    expect(body.faces!.faceQueries).toHaveLength(2)
  })

  it('offers no layers at all for an empty mesh', () => {
    const body = build({
      vertices: new Float32Array(0),
      indices: new Uint32Array(0),
      faceIdsPerTriangle: new Uint32Array(0),
      edges: [],
    })
    expect(body.faces).toBeNull()
    expect(body.edges).toBeNull()
    expect(body.vertices).toBeNull()
  })
})
