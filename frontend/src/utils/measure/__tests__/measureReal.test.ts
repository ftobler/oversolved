// @vitest-environment node
//
// The readout against the real kernel: a 40 x 30 x 10 plate on Top with a d=8
// through hole at its centre. Every pick pair is addressed by the solve's own
// query strings, so the test covers the routing and the adapters as the
// viewport uses them, not hand-built fixtures.
//
// The probe that motivated the feature reported a "plane distance" for a flat
// face plus the hole's cylinder face: the old rule read the face's radial
// centroid normal as a plane normal. That cell is pinned here as an axis
// distance.
//
// Skips when OCC.js or the Rust sketch solver is absent.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { resetSketchSolver, setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setSolveLocalsForTest, solveLocally } from '@/kernel/solveLocally'
import { measureSelection } from '@/utils/measure/measureSelection'
import type { PartResult, EdgeData, FaceData } from '@/types/cad'

const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketch(id: string, w: number, h: number, plane: string): Record<string, unknown> {
  return {
    id, kind: 'sketch', plane,
    entities: [
      { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
      { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
    ],
    initial: {
      bottom: [0, 0, w, 0], right: [w, 0, w, h],
      top: [w, h, 0, h], left: [0, h, 0, 0],
    },
    constraints: [
      { id: 'c1', kind: 'coincident', a: { entity: 'bottom', point: 'end' }, b: { entity: 'right', point: 'start' } },
      { id: 'c2', kind: 'coincident', a: { entity: 'right', point: 'end' }, b: { entity: 'top', point: 'start' } },
      { id: 'c3', kind: 'coincident', a: { entity: 'top', point: 'end' }, b: { entity: 'left', point: 'start' } },
      { id: 'c4', kind: 'coincident', a: { entity: 'left', point: 'end' }, b: { entity: 'bottom', point: 'start' } },
      { id: 'c5', kind: 'horizontal', target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal', target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical', target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical', target: { entity: 'left' } },
      { id: 'c9', kind: 'length', target: { entity: 'bottom' }, value: w },
      { id: 'c10', kind: 'length', target: { entity: 'left' }, value: h },
    ],
  }
}

// The bore's sketch: a point at the drill site (a hole drills points, its
// diameter is the feature's). The point is free, so the solve keeps (20, 15).
function holeSketch(id: string, cx: number, cy: number): Record<string, unknown> {
  return {
    id, kind: 'sketch', plane: '@builtin_plane_top',
    entities: [{ id: 'hole', kind: 'point' }],
    initial: { hole: [cx, cy] },
    constraints: [],
  }
}

function probeDoc(): Record<string, unknown> {
  return {
    id: 'measure-real',
    features: [
      rectSketch('sk1', 40, 30, '@builtin_plane_top'),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' },
      holeSketch('skHole', 20, 15),
      {
        id: 'h1', kind: 'hole',
        hole: { sketch: '@skHole', diameter: 8, depth_mode: 'through_all', direction: 'normal', target: '@body_ex1' },
      },
    ],
  }
}

const LENGTH_EPS = 1e-6

function close(value: number, expected: number): boolean {
  return Math.abs(value - expected) < LENGTH_EPS
}

describe.skipIf(!oc || !solveBytes)('measureSelection on the probe plate (real OCC + Rust solver)', () => {
  let parts: Record<string, PartResult>
  let part: PartResult

  beforeAll(async () => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
    // The shared test setup wires topology before each TEST, but this suite
    // solves in beforeAll, before that hook can run.
    setSketchTopology(loadTopology())
    setSolveLocalsForTest(async () => oc)
    const response = await solveLocally(probeDoc())
    if (!response) throw new Error('unreachable: skipIf guards this')
    const failed = Object.entries(response.result)
      .filter(([, result]) => (result as { status?: string }).status === 'exception')
    if (failed.length) throw new Error(`feature exception: ${JSON.stringify(failed)}`)
    parts = response.bodies as Record<string, PartResult>
    const id = Object.keys(parts).find((key) => key.startsWith('body_ex'))
    if (!id) throw new Error(`no extruded body in ${JSON.stringify(Object.keys(parts))} result=${JSON.stringify(response.result)}`)
    part = parts[id]
  }, 180_000)

  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  function measure(ids: string[]): string[] {
    return measureSelection(new Set(ids), { parts: parts })
  }

  function lineLength(edge: EdgeData): number {
    if (edge.kind !== 'line') return -1
    return Math.hypot(
      edge.end[0] - edge.start[0],
      edge.end[1] - edge.start[1],
      edge.end[2] - edge.start[2],
    )
  }

  function edgeQuery(match: (edge: EdgeData) => boolean): string {
    const index = (part.edges ?? []).findIndex(match)
    const query = index >= 0 ? part.edge_queries?.[index] : undefined
    if (!query) throw new Error(`no matching edge query; edges: ${JSON.stringify(part.edges)}`)
    return query
  }

  function faceQuery(match: (face: FaceData) => boolean): string {
    const index = (part.mesh?.face_data ?? []).findIndex(match)
    const query = index >= 0 ? part.mesh?.face_queries?.[index] : undefined
    if (!query) throw new Error(`no matching face query; faces: ${JSON.stringify(part.mesh?.face_data)}`)
    return query
  }

  function vertexQuery(at: [number, number, number]): string {
    const index = (part.vertices ?? []).findIndex((v) => close(v[0], at[0]) && close(v[1], at[1]) && close(v[2], at[2]))
    const query = index >= 0 ? part.vertex_queries?.[index] : undefined
    if (!query) throw new Error(`no vertex at ${JSON.stringify(at)}; vertices: ${JSON.stringify(part.vertices)}`)
    return query
  }

  // The plate spans world x [0, 40], y [0, 10] and z [-30, 0] (Top's local y is
  // world -z). A line edge on the Top sketch plane (y=0, z=0) named by its
  // direction and offset.
  const topEdge = (axis: 'x' | 'y' | 'z', length: number): string =>
    edgeQuery((edge) => {
      if (edge.kind !== 'line') return false
      const sameY = close(edge.start[1], 0) && close(edge.end[1], 0)
      const sameZ = close(edge.start[2], 0) && close(edge.end[2], 0)
      const sameX = close(edge.start[0], 0) && close(edge.end[0], 0)
      if (axis === 'x') return sameY && sameZ && close(lineLength(edge), length)
      if (axis === 'y') return sameX && close(lineLength(edge), length)
      return sameY && sameX === false && close(Math.abs(edge.end[2] - edge.start[2]), length)
    })

  const flatFace = (nx: number, ny: number, nz: number): string =>
    faceQuery((face) =>
      face.surface_type === 'flatface' &&
      close(face.normal[0], nx) && close(face.normal[1], ny) && close(face.normal[2], nz))

  const holeFace = (): string => faceQuery((face) => face.surface_type === 'cylinderface')

  const holeEdge = (): string => edgeQuery((edge) => edge.kind === 'circle')
  const holeEdgeAt = (y: number): string =>
    edgeQuery((edge) => edge.kind === 'circle' && close(edge.center[1], y))
  const flatFaceAtY = (y: number): string =>
    faceQuery((face) => face.surface_type === 'flatface' && close(face.centroid[1], y))

  it('reads the three plate edge lengths and the bore diameter', () => {
    // 40 along x, 30 along z (Top's local y) and 10 along the extrude axis.
    expect(measure([topEdge('x', 40)])).toEqual(['length 40.000 mm'])
    expect(measure([topEdge('z', 30)])).toEqual(['length 30.000 mm'])
    expect(measure([topEdge('y', 10)])).toEqual(['length 10.000 mm'])
    expect(measure([holeEdge()])).toEqual(['diameter 8.000 mm'])
    expect(measure([holeFace()])).toEqual(['diameter 8.000 mm'])
  })

  it('reads the plate thickness and the angle between two side faces', () => {
    // Top and bottom are the flat faces whose normals run along the extrude
    // axis; the side faces at x=0 and z=0 are perpendicular.
    expect(measure([flatFace(0, 1, 0), flatFace(0, -1, 0)])).toEqual(['distance 10.000 mm'])
    expect(measure([flatFace(-1, 0, 0), flatFace(0, 0, 1)])).toEqual(['angle 90.0°'])
  })

  it('reads the bore axis against a side face as an axis distance, not a plane distance', () => {
    // Both faces are 20 from the bore axis in x and 15 in z; the old rule read
    // the hole face's radial normal as a plane and reported a plausible number
    // through the two centroids.
    expect(measure([flatFace(-1, 0, 0), holeFace()])).toEqual(['axis distance 20.000 mm'])
    expect(measure([flatFace(0, 0, 1), holeFace()])).toEqual(['axis distance 15.000 mm'])
  })

  it('reads a hole face against a line edge as an angle, not a plane distance', () => {
    // The bore axis is world y; the plate's long edge runs along x.
    expect(measure([holeFace(), topEdge('x', 40)])).toEqual(['angle 90.0°'])
  })

  it('reads the bore axis against a corner vertex', () => {
    // The corner (0, 0, 0) is 20 in x and 15 in z from the axis.
    expect(measure([holeFace(), vertexQuery([0, 0, 0])])).toEqual(['axis distance 25.000 mm'])
  })

  it('reads vertex, line and circle pairs from the solve queries', () => {
    expect(measure([vertexQuery([0, 0, 0]), vertexQuery([40, 0, -30])]))
      .toEqual(['distance 50.000 mm'])
    expect(measure([topEdge('x', 40), vertexQuery([0, 10, 0])]))
      .toEqual(['distance 10.000 mm'])
    expect(measure([holeEdge(), vertexQuery([0, 0, 0])]))
      .toEqual(['center distance 25.000 mm'])
    expect(measure([topEdge('x', 40), holeEdge()]))
      .toEqual(['center distance 15.000 mm'])
  })

  it('reads the bore rim edges against the Top face as center-to-plane distances', () => {
    // The mouth lies in the y=0 face (0 away) and the exit in the y=10 face.
    expect(measure([flatFaceAtY(0), holeEdgeAt(0)])).toEqual(['distance 0.000 mm'])
    expect(measure([flatFaceAtY(0), holeEdgeAt(10)])).toEqual(['distance 10.000 mm'])
    expect(measure([flatFaceAtY(10), holeEdgeAt(10)])).toEqual(['distance 0.000 mm'])
  })
})
