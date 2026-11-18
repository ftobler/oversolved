// @vitest-environment node
//
// The render-order trap, pinned by construction: a measurement pick names a body
// element by its index in the SOLVE's render arrays, and only the vertex array
// is in canonical sub-shape order. Faces are sorted flat-before-curved and edges
// by curve kind then geometry with the degenerated ones dropped.
//
// Every assertion here compares the resolver's answer against the render array
// at the same index, so a resolver that read a canonical index instead of
// re-walking the render order would land on a neighbour and fail.
//
// Skips when OCC.js or the Rust sketch solver is absent.
import { beforeAll, describe, expect, it } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { resetSketchSolver, setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { persistentTableForTest, setSolveLocalsForTest, solveLocally } from '@/kernel/solveLocally'
import { DisposeScope } from '@/kernel/occ/disposeScope'
import { canonicalEdges } from '@/kernel/occ/partNames'
import { renderEdgeRows } from '@/kernel/occ/tessellation'
import { makeCone } from '@/kernel/occ/primitives'
import { resolveMeasurePick } from '@/kernel/measurePick'
import type { PartSolid, BuildState } from '@/kernel/types3d'
import type { PartResult, EdgeData, FaceData } from '@/types/cad'
import type { OccCurveAdaptor, OccModule, OccShape } from '@/kernel/occ/occTypes'
import type { Vec3 } from '@/utils/measure/primitives'

const oc = await loadOcc()
const solveBytes = loadSolver()

const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6

function rectSketch(id: string, w: number, h: number): Record<string, unknown> {
  return {
    id, kind: 'sketch', plane: '@builtin_plane_top',
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

function holeSketch(): Record<string, unknown> {
  return {
    id: 'skHole', kind: 'sketch', plane: '@builtin_plane_top',
    entities: [{ id: 'hole', kind: 'point' }],
    initial: { hole: [20, 15] },
    constraints: [],
  }
}

/** The extruded rectangle with a bore: a fillet picks its vertical edges. */
function plateDoc(docId: string): Record<string, unknown> {
  return {
    id: docId,
    features: [
      rectSketch('sk1', 40, 30),
      { id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' } },
      holeSketch(),
      {
        id: 'h1', kind: 'hole',
        hole: { sketch: '@skHole', diameter: 8, depth_mode: 'through_all', direction: 'normal', target: '@body_ex1' },
      },
    ],
  }
}

async function solvedParts(doc: Record<string, unknown>): Promise<{
  result: Record<string, PartResult>
  store: Record<string, PartSolid>
  table: NonNullable<ReturnType<typeof persistentTableForTest>>
}> {
  const response = await solveLocally(doc)
  if (!response) throw new Error('no build response')
  const failed = Object.entries(response.result)
    .filter(([, r]) => (r as { status?: string }).status === 'exception')
  if (failed.length) throw new Error(`feature exception: ${JSON.stringify(failed)}`)
  const state = response._build_state as BuildState
  const store = state.checkpoints[state.feature_order[state.feature_order.length - 1]]
    .body_store_snapshot as Record<string, PartSolid>
  const table = persistentTableForTest()
  if (!table) throw new Error('no handle table')
  return { result: response.bodies as Record<string, PartResult>, store, table }
}

const partIdOf = (result: Record<string, PartResult>): string => {
  const id = Object.keys(result).find((key) => key.startsWith('body_ex'))
  if (!id) throw new Error(`no extruded body in ${JSON.stringify(Object.keys(result))}`)
  return id
}

/** The edges a line reads, as the render array states them. */
function lineLength(edge: EdgeData): number {
  if (edge.kind !== 'line') return -1
  return Math.hypot(edge.end[0] - edge.start[0], edge.end[1] - edge.start[1], edge.end[2] - edge.start[2])
}

/** The render array's own midpoint for an edge kind that has one. */
function edgeMid(edge: EdgeData): Vec3 | null {
  if (edge.kind === 'line') {
    return [(edge.start[0] + edge.end[0]) / 2, (edge.start[1] + edge.end[1]) / 2, (edge.start[2] + edge.end[2]) / 2]
  }
  if (edge.kind === 'spline') return null
  const sweep = edge.angle_end - edge.angle_start
  const mid = edge.angle_start + sweep / 2
  const x = edge.x_axis
  // OCC's circle/ellipse frame: YDir = Axis x XDir.
  const y: Vec3 = [
    edge.axis[1] * x[2] - edge.axis[2] * x[1],
    edge.axis[2] * x[0] - edge.axis[0] * x[2],
    edge.axis[0] * x[1] - edge.axis[1] * x[0],
  ]
  const a = edge.kind === 'ellipse' ? edge.a : edge.radius
  const b = edge.kind === 'ellipse' ? edge.b : edge.radius
  return [
    edge.center[0] + a * Math.cos(mid) * x[0] + b * Math.sin(mid) * y[0],
    edge.center[1] + a * Math.cos(mid) * x[1] + b * Math.sin(mid) * y[1],
    edge.center[2] + a * Math.cos(mid) * x[2] + b * Math.sin(mid) * y[2],
  ]
}

function curveMid(occ2: OccModule, scope: DisposeScope, shape: OccShape): Vec3 {
  const curve = scope.track(new occ2.BRepAdaptor_Curve_2(shape)) as OccCurveAdaptor
  const u = (curve.FirstParameter() + curve.LastParameter()) / 2
  const p = curve.Value(u)
  return [p.X(), p.Y(), p.Z()]
}

function curveKind(occ2: OccModule, scope: DisposeScope, shape: OccShape): string {
  const curve = scope.track(new occ2.BRepAdaptor_Curve_2(shape))
  const t = curve.GetType().value
  const S = occ2.GeomAbs_CurveType
  if (t === S.GeomAbs_Line.value) return 'line'
  if (t === S.GeomAbs_Ellipse.value) return 'ellipse'
  if (t === S.GeomAbs_Circle.value) {
    // The render pass calls a closed circle a circle and an open one an arc.
    const span = Math.abs(curve.LastParameter() - curve.FirstParameter())
    return span >= Math.PI * 2 - 1e-4 ? 'circle' : 'arc'
  }
  return 'spline'
}

describe.skipIf(!oc || !solveBytes)('resolveMeasurePick follows the render order (real OCC)', () => {
  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
    setSketchTopology(loadTopology())
    setSolveLocalsForTest(async () => oc)
  }, 180_000)

  it('maps every edge index of a filleted plate with a bore back to the same edge', async () => {
    const occ2 = oc as OccModule
    // First solve: the plate, whose edges name the vertical ones a fillet takes.
    const first = await solvedParts(plateDoc('measure-pick-first'))
    const firstPart = first.result[partIdOf(first.result)]
    const vertical = (firstPart.edges ?? [])
      .map((edge, i) => ({ edge, query: firstPart.edge_queries?.[i] ?? '' }))
      .filter(({ edge }) => edge.kind === 'line' && close(lineLength(edge), 10) && edge.start[0] === edge.end[0])
    expect(vertical.length).toBeGreaterThanOrEqual(4)
    const filletQueries = vertical.slice(0, 4).map(({ query }) => query)
    expect(filletQueries.every((q) => q !== '')).toBe(true)

    // Second solve: the same plate with those four edges filleted, so the body
    // carries lines, circular rims and the fillet's own edges.
    const doc = plateDoc('measure-pick-fillet')
    ;(doc.features as Record<string, unknown>[]).push({
      id: 'fi1', kind: 'fillet', fillet: { edges: filletQueries, radius: 2 },
    })
    const second = await solvedParts(doc)
    const id = partIdOf(second.result)
    const part = second.result[id]
    const scope = new DisposeScope()
    try {
      const edges = part.edges ?? []
      expect(edges.length).toBeGreaterThanOrEqual(14)
      const kinds = new Set(edges.map((e) => e.kind))
      // The point of the fixture: more than one edge kind, so a shifted index
      // cannot pass by landing on an edge of the same shape.
      expect(kinds.has('line')).toBe(true)
      expect(kinds.has('circle')).toBe(true)

      for (let i = 0; i < edges.length; i++) {
        const shape = resolveMeasurePick(occ2, scope, second.table, second.store, { bodyId: id, kind: 'edge', index: i })
        expect(shape).not.toBeNull()
        const read = shape as OccShape
        expect(curveKind(occ2, scope, read)).toBe(edges[i].kind)
        const expectedMid = edgeMid(edges[i])
        if (expectedMid !== null) {
          const mid = curveMid(occ2, scope, read)
          expect(mid[0]).toBeCloseTo(expectedMid[0], 6)
          expect(mid[1]).toBeCloseTo(expectedMid[1], 6)
          expect(mid[2]).toBeCloseTo(expectedMid[2], 6)
        }
      }

      // Out of range names nothing rather than the last edge.
      expect(resolveMeasurePick(occ2, scope, second.table, second.store, { bodyId: id, kind: 'edge', index: edges.length })).toBeNull()
    } finally {
      scope.dispose()
    }
  }, 300_000)

  it('maps every face and vertex index back to the same element', async () => {
    const occ2 = oc as OccModule
    const solved = await solvedParts(plateDoc('measure-pick-plate'))
    const id = partIdOf(solved.result)
    const part = solved.result[id]
    const scope = new DisposeScope()
    try {
      const faces = part.mesh?.face_data ?? []
      expect(faces.length).toBeGreaterThan(6)
      for (let i = 0; i < faces.length; i++) {
        const shape = resolveMeasurePick(occ2, scope, solved.table, solved.store, { bodyId: id, kind: 'face', index: i })
        expect(shape).not.toBeNull()
        const read = shape as OccShape
        // The face's own measure, read through BRepGProp: an independent
        // centroid that must land on the face the render array calls i.
        const props = scope.track(new occ2.GProp_GProps_1())
        occ2.BRepGProp.SurfaceProperties_1(read, props, false, false)
        const centre = props.CentreOfMass()
        const expected = (faces[i] as FaceData).centroid
        // The render centroid is the surface's parameter midpoint, the area
        // centroid is close to it but not identical, so this is a proximity
        // check on a face-sized scale.
        expect(Math.hypot(centre.X() - expected[0], centre.Y() - expected[1], centre.Z() - expected[2]))
          .toBeLessThan(5)
      }

      const vertices = part.vertices ?? []
      expect(vertices.length).toBeGreaterThan(4)
      for (let i = 0; i < vertices.length; i++) {
        const shape = resolveMeasurePick(occ2, scope, solved.table, solved.store, { bodyId: id, kind: 'vertex', index: i })
        expect(shape).not.toBeNull()
        const p = scope.track(occ2.BRep_Tool.Pnt(shape as OccShape))
        expect(p.X()).toBeCloseTo(vertices[i][0], 9)
        expect(p.Y()).toBeCloseTo(vertices[i][1], 9)
        expect(p.Z()).toBeCloseTo(vertices[i][2], 9)
      }
    } finally {
      scope.dispose()
    }
  }, 300_000)

  it('skips a degenerated edge exactly as the render pass does', () => {
    const occ2 = oc as OccModule
    const scope = new DisposeScope()
    try {
      // A cone's apex is a degenerated edge: the canonical walk counts it, the
      // render arrays drop it, so the two counts differ by at least one.
      const cone = makeCone(occ2, scope, [0, 0, 0], [0, 0, 1], 5, 0, 10)
      const canonical = canonicalEdges(occ2, scope, cone)
      const rows = renderEdgeRows(occ2, scope, cone)
      expect(rows.length).toBeLessThan(canonical.length)
      expect(rows.length).toBeGreaterThan(0)
      // Every render row carries the canonical index of its own edge, and that
      // index is not simply the row's position: the dropped edge sits inside the
      // canonical order, so a canonical read for row i would name a neighbour.
      expect(rows.some((row, i) => row.canon !== i)).toBe(true)
      for (const row of rows) expect(canonical[row.canon]).toBeDefined()
    } finally {
      scope.dispose()
    }
  })
})
