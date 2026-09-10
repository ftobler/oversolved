// The ID-layer payloads the assembly scene registers. The invariant that matters
// is the positional join: a pick lands on a triangle or a segment, and the query
// it names must be the entity `entityAnchors` indexed anchors under.

import { describe, it, expect } from 'vitest'
import type { BodyResult, PartInstance, Transform3D } from '@/types/cad'
import type { MeshPayload } from '@/kernel/solveAssembly'
import { assemblyEntityKey } from '@/utils/anchorCandidates'
import { buildAnchorTable, type AnchorTable } from '@/utils/anchorGizmos'
import { buildPickBodies, offsetPickBodies } from '@/utils/assemblyPick'
import { getAssemblyPartGroups } from '@/utils/assemblyRender'
import { IDENTITY_TRANSFORM, makeTransform, rotateVector } from '@/utils/transform3d'
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
    // The offsetter keys each body's pose by its instance handle, not the bodyKey.
    expect(bodies.map(b => b.handle)).toEqual([PART, PART])
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

  it('builds a triangle-perimeter boundary loop for a face with one triangle', () => {
    const { faceBoundaries } = build(makeMesh())
    // Triangle 0 (verts 0,1,2): all 3 edges are unshared within face 0, so all 3 survive.
    expect(faceBoundaries!.get(0)!.length).toBe(3 * 6)
    expect(faceBoundaries!.get(1)!.length).toBe(3 * 6)
  })

  it('drops the shared interior edge when two triangles tessellate one face', () => {
    const mesh = makeMesh({ faceIdsPerTriangle: new Uint32Array([0, 0]) })
    const { faceBoundaries } = build(mesh)
    // Triangles (0,1,2) and (1,3,2) share edge (1,2): that edge appears twice
    // within face 0 and is interior, not boundary, so only the 4 outer edges
    // of the resulting quad remain.
    expect(faceBoundaries!.get(0)!.length).toBe(4 * 6)
    expect(faceBoundaries!.has(1)).toBe(false)
  })

  it('offers no face boundaries for an empty mesh', () => {
    const body = build({
      vertices: new Float32Array(0),
      indices: new Uint32Array(0),
      faceIdsPerTriangle: new Uint32Array(0),
      edges: [],
    })
    expect(body.faceBoundaries).toBeNull()
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

// The ID buffer is registered from a solve-time snapshot; the parts are drawn at
// the settling pose. The offset keeps those two descriptions of "where the
// geometry is" in step through a commit, so a click in the window lands on the
// entity under the cursor instead of its pre-drag twin.
describe('offsetPickBodies', () => {
  function renderBody(handle: string): BodyResult {
    return {
      id: `${handle}:body_0`,
      created_by: handle,
      modified_by: [],
      mesh: {
        vertices: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
        faces: new Uint32Array([0, 1, 2]),
      },
    }
  }

  function part(handle: string): PartInstance {
    return { handle, doc_id: `doc-${handle}`, doc_rev: 1, transform: { ...IDENTITY_TRANSFORM } }
  }

  it('translates every layer of the pick body onto the drawn pose', () => {
    const pick = build(makeMesh())
    const drawn = { [PART]: { ...IDENTITY_TRANSFORM, tx: 3 } }
    const [moved] = offsetPickBodies([pick], { [PART]: IDENTITY_TRANSFORM }, drawn)

    // Faces: the first triangle's first vertex sits at the part origin.
    expect([...moved.faces!.positions.slice(0, 3)]).toEqual([3, 0, 0])
    // Edges: the line segment from x=0 to x=10.
    expect([...moved.edges!.segmentPositions.slice(0, 6)]).toEqual([3, 0, 0, 13, 0, 0])
    // Vertices: the two anchor points already carried into the solved pose.
    expect(moved.vertices!.vertices).toEqual([[3, 0, 0], [13, 0, 0]])
    // Face boundaries: triangle 0's perimeter.
    expect([...moved.faceBoundaries!.get(0)!.slice(0, 3)]).toEqual([3, 0, 0])
  })

  it('places a pick vertex at the same world point the render group draws', () => {
    const pick = build(makeMesh())
    const offset: Transform3D = { ...IDENTITY_TRANSFORM, tx: 3, ty: -2 }
    const [moved] = offsetPickBodies([pick], { [PART]: IDENTITY_TRANSFORM }, { [PART]: offset })

    const group = getAssemblyPartGroups(
      { [`${PART}:body_0`]: renderBody(PART) },
      [part(PART)],
      null,
      null,
      { [PART]: offset },
    )[0]
    const groupOffset = makeTransform(group.position, group.quaternion)
    const [rx, ry, rz] = rotateVector(
      [groupOffset.qx, groupOffset.qy, groupOffset.qz, groupOffset.qw],
      [0, 0, 0],
    )
    expect(moved.faces!.positions[0]).toBeCloseTo(rx + groupOffset.tx, 9)
    expect(moved.faces!.positions[1]).toBeCloseTo(ry + groupOffset.ty, 9)
    expect(moved.faces!.positions[2]).toBeCloseTo(rz + groupOffset.tz, 9)
  })

  it('returns an identity-offset body by reference (no churn)', () => {
    const pick = build(makeMesh())
    const same = offsetPickBodies([pick], { [PART]: IDENTITY_TRANSFORM }, { [PART]: IDENTITY_TRANSFORM })
    expect(same[0]).toBe(pick)
  })

  it('leaves a body with no baked pose alone', () => {
    const pick = build(makeMesh())
    const same = offsetPickBodies([pick], {}, { [PART]: { ...IDENTITY_TRANSFORM, tx: 3 } })
    expect(same[0]).toBe(pick)
  })
})
