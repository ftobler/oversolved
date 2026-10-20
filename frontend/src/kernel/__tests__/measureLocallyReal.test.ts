// @vitest-environment node
//
// Real-kernel test for measureLocally: build documents and read back volume,
// surface area, centroid, AABB and B-rep counts. The body set is the last
// checkpoint's snapshot, the same one the export path serialises.
//
// Skips when OCC.js or the Rust sketch solver is absent. Install OCC with:
//   cd frontend && npm run occ:install

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { measureLocally, persistentTableForTest, setSolveLocalsForTest, solveLocally } from '../solveLocally'
import { setSketchSolver, resetSketchSolver } from '../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { DisposeScope } from '../occ/disposeScope'
import { measureBodies, type Bbox6 } from '../occ/measure'
import { readOracleCase } from '@/oracle/corpus'
import { partSpecFromText } from '@/utils/partExport'
import type { BuildState } from '../types3d'
import type { OccModule, OccShape } from '../occ/occTypes'

const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketch(sketchId: string, w: number, h: number, plane = '@builtin_plane_front') {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane,
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: { bottom: [0, 0, w, 0], right: [w, 0, w, h], top: [w, h, 0, h], left: [0, h, 0, 0] },
    constraints: [
      { id: 'c1', kind: 'coincident' as const, a: { entity: 'bottom', point: 'end' as const }, b: { entity: 'right', point: 'start' as const } },
      { id: 'c2', kind: 'coincident' as const, a: { entity: 'right', point: 'end' as const }, b: { entity: 'top', point: 'start' as const } },
      { id: 'c3', kind: 'coincident' as const, a: { entity: 'top', point: 'end' as const }, b: { entity: 'left', point: 'start' as const } },
      { id: 'c4', kind: 'coincident' as const, a: { entity: 'left', point: 'end' as const }, b: { entity: 'bottom', point: 'start' as const } },
      { id: 'c5', kind: 'horizontal' as const, target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal' as const, target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical' as const, target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical' as const, target: { entity: 'left' } },
      { id: 'c9', kind: 'length' as const, target: { entity: 'bottom' }, value: w },
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: h },
    ],
  }
}

function extrude(sketchId: string, id: string, distance: number): Record<string, unknown> {
  return { id, kind: 'extrude', sketch: '$' + sketchId, distance, direction: 'normal', operation: 'new' }
}

// 10 x 10 x 5 box on the front plane: volume 500, area 2*100 + 4*50 = 400,
// centroid [5, 5, 2.5], AABB [0,0,0]..[10,10,5], 6/12/8 B-rep counts.
function boxDoc() {
  return { id: 'measureDoc', features: [rectSketch('sk1', 10, 10), extrude('sk1', 'ex1', 5)] }
}

// Two solids: 10*10*5 = 500 plus 6*6*4 = 144.
function twoBodyDoc() {
  return {
    id: 'measureDoc',
    features: [
      rectSketch('sk1', 10, 10),
      extrude('sk1', 'ex1', 5),
      rectSketch('sk2', 6, 6, '@builtin_plane_right'),
      extrude('sk2', 'ex2', 4),
    ],
  }
}

// A corpus recipe as a doc with its own id, plus the case's analytic measures.
function oracleDoc(name: string): { doc: Record<string, unknown>; expected: ReturnType<typeof readOracleCase>['expected'] } {
  const oracleCase = readOracleCase(name)
  const doc = partSpecFromText(oracleCase.recipe)
  doc.id = `measure-${name}`
  return { doc, expected: oracleCase.expected }
}

// An open planar face: a 10 x 10 square at x, with no solid to close it.
function openSquare(oc: OccModule, scope: DisposeScope, x: number): OccShape {
  const corners = [[x, 0, 0], [x, 10, 0], [x, 10, 10], [x, 0, 10]]
  const poly = scope.track(new oc.BRepBuilderAPI_MakePolygon_1())
  for (const [px, py, pz] of corners) {
    const p = scope.track(new oc.gp_Pnt_3(px, py, pz))
    poly.Add_1(p)
  }
  poly.Close()
  const builder = scope.track(new oc.BRepBuilderAPI_MakeFace_15(poly.Wire(), true))
  return scope.track(builder.Face())
}

// A cube small enough that its volume stays below measureBodies' weight floor.
function tinyBox(oc: OccModule, scope: DisposeScope, corner: [number, number, number]): OccShape {
  const p = scope.track(new oc.gp_Pnt_3(corner[0], corner[1], corner[2]))
  return scope.track(new oc.BRepPrimAPI_MakeBox_2(p, 5e-5, 5e-5, 5e-5).Shape())
}

describe.skipIf(!oc || !solveBytes)('measureLocally (real OCC + Rust solver)', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
    setSolveLocalsForTest(async () => oc)
  })
  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('measures a box: volume, area, centroid, AABB and counts', async () => {
    const measure = await measureLocally(boxDoc())
    expect(measure).not.toBeNull()
    expect(measure!.bodies).toBe(1)
    expect(measure!.volume).toBeCloseTo(500, 6)
    expect(measure!.area).toBeCloseTo(400, 6)
    expect(measure!.centroid![0]).toBeCloseTo(5, 6)
    expect(measure!.centroid![1]).toBeCloseTo(5, 6)
    expect(measure!.centroid![2]).toBeCloseTo(2.5, 6)
    expect(measure!.bbox!.map(v => +v.toFixed(6))).toEqual([0, 0, 0, 10, 10, 5])
    expect(measure!.faces).toBe(6)
    expect(measure!.edges).toBe(12)
    expect(measure!.vertices).toBe(8)
  })

  it('sums volumes and areas over two bodies and unions their AABBs', async () => {
    const measure = await measureLocally(twoBodyDoc())
    expect(measure).not.toBeNull()
    expect(measure!.bodies).toBe(2)
    expect(measure!.volume).toBeCloseTo(644, 6)
    // Box 1: 2*100 + 4*50 = 400. Box 2 (6x6x4): 2*36 + 4*24 = 168.
    expect(measure!.area).toBeCloseTo(568, 6)
    expect(measure!.faces).toBe(12)
    expect(measure!.edges).toBe(24)
    expect(measure!.vertices).toBe(16)
    // The union contains the first box's AABB regardless of where the second
    // one sits on the right plane.
    for (let axis = 0; axis < 3; axis++) {
      expect(measure!.bbox![axis]).toBeLessThanOrEqual(1e-6)
      expect(measure!.bbox![axis + 3]).toBeGreaterThanOrEqual([10, 10, 5][axis] - 1e-6)
    }
  })

  it('reports an empty measure for a document with no solid body', async () => {
    const measure = await measureLocally({ id: 'empty', features: [rectSketch('sk1', 4, 4)] })
    expect(measure).toMatchObject({ bodies: 0, volume: 0, area: 0, centroid: null, bbox: null, faces: 0 })
  })

  it('reads an exact AddOptimal bbox for the analytic cylinder (oracle 04)', async () => {
    const { doc, expected } = oracleDoc('04-cylinder')
    const measure = await measureLocally(doc)
    expect(measure).not.toBeNull()
    for (let axis = 0; axis < 6; axis++) {
      // 1e-9 is far below the Bnd_Box gap Add would add, so this also pins the
      // chosen binding as the no-shape-tolerance AddOptimal overload.
      expect(measure!.bbox![axis]).toBeCloseTo(expected.bbox[axis], 9)
    }
    expect(measure!.volume).toBeCloseTo(expected.volume, 6)
    expect(measure!.area).toBeCloseTo(expected.area, 6)
  })

  it('reads an exact AddOptimal bbox for the enclosed-sphere union (oracle 22)', async () => {
    const { doc, expected } = oracleDoc('22-boolean-union-enclosed-sphere')
    const measure = await measureLocally(doc)
    expect(measure).not.toBeNull()
    for (let axis = 0; axis < 6; axis++) {
      expect(measure!.bbox![axis]).toBeCloseTo(expected.bbox[axis], 9)
    }
    expect(measure!.volume).toBeCloseTo(expected.volume, 6)
  })

  it('reads the tight AddOptimal bbox on a B-spline sweep, not the control net (oracle 37)', { timeout: 120_000 }, async () => {
    const kernel = oc!
    const { doc } = oracleDoc('37-sweep-helix-square')
    const response = await solveLocally(doc)
    expect(response).not.toBeNull()

    const state = response!._build_state as BuildState
    const last = state.feature_order[state.feature_order.length - 1]
    const snapshot = last !== undefined ? state.checkpoints[last]?.body_store_snapshot : undefined
    const table = persistentTableForTest()
    expect(table).not.toBeNull()
    const shapes: OccShape[] = []
    for (const body of Object.values(snapshot ?? {})) {
      if (body.shape != null) shapes.push(table!.get<OccShape>(body.shape))
    }
    expect(shapes).toHaveLength(1)

    // The loose read is pinned for contrast: the oracle and `measureBodies`
    // use AddOptimal, while Add boxes this B-spline surface's control net and
    // overshoots the swept solid by more than six units.
    const looseScope = new DisposeScope()
    let loose: Bbox6
    try {
      const box = looseScope.track(new kernel.Bnd_Box_1())
      for (const shape of shapes) kernel.BRepBndLib.Add(shape, box, false)
      loose = [
        box.GetXmin(), box.GetYmin(), box.GetZmin(),
        box.GetXmax(), box.GetYmax(), box.GetZmax(),
      ]
    } finally {
      looseScope.dispose()
    }

    const measureScope = new DisposeScope()
    try {
      const record = measureBodies(kernel, measureScope, shapes)
      // Frozen from the real kernel: the tight box the swept surface occupies.
      const tight: Bbox6 = [
        -10.499988797020961, -10.499999483832946, -0.5000000999999998,
        10.500000100000927, 10.499999483832985, 12.500000099999998,
      ]
      expect(record.bbox).not.toBeNull()
      for (let axis = 0; axis < 6; axis++) {
        expect(record.bbox![axis]).toBeCloseTo(tight[axis], 6)
      }
      // The control-net box is the one the corpus froze before the shared
      // measure; pin it too so the gap is reproducible, not assumed.
      expect(loose.map((value) => +value.toFixed(6))).toEqual(
        [-16.896365, -15.363061, -0.5, 10.5, 15.363061, 12.5],
      )
      // Add is not a slightly larger box here; it is a different box, which is
      // why an external tool's bbox cannot be compared against it.
      const maxOvershoot = Math.max(...loose.map((value, axis) => Math.abs(value - tight[axis])))
      expect(maxOvershoot).toBeGreaterThan(6)
    } finally {
      measureScope.dispose()
    }
  })

  it('keeps the open-shell fallback finite instead of dividing by a zero volume', () => {
    const kernel = oc!
    const build = new DisposeScope()
    const measureScope = new DisposeScope()
    try {
      const record = measureBodies(kernel, measureScope, [openSquare(kernel, build, 20)])

      expect(record.bodies).toBe(1)
      expect(record.volume).toBeCloseTo(0)
      // The only-closed volume pass has no material to place in an unclosed
      // shell, so BRepGProp reports the origin. The fallback must keep that
      // value finite rather than divide the weighted sum by ~0, and the bbox
      // still describes the shell.
      expect(record.centroid).toEqual([0, 0, 0])
      expect(record.bbox).toEqual([20, 0, 0, 20, 10, 10])
    } finally {
      measureScope.dispose()
      build.dispose()
    }
  })

  it('averages the known body centres when every body integrates to zero volume', () => {
    const kernel = oc!
    const build = new DisposeScope()
    const measureScope = new DisposeScope()
    try {
      // Two 5e-5 cubes: 1.25e-13 each, so the summed volume is below the
      // 1e-12 weight floor and the plain body average is the fallback.
      const shapes = [tinyBox(kernel, build, [0, 0, 0]), tinyBox(kernel, build, [20, 0, 0])]
      const record = measureBodies(kernel, measureScope, shapes)

      expect(record.volume).toBeGreaterThan(0)
      expect(record.volume).toBeLessThan(1e-12)
      // Each cube's centre is its corner plus half a side; the expected values
      // are the geometric mean of those centres, not a weighted division.
      expect(record.centroid![0]).toBeCloseTo(10 + 2.5e-5, 6)
      expect(record.centroid![1]).toBeCloseTo(2.5e-5, 6)
      expect(record.centroid![2]).toBeCloseTo(2.5e-5, 6)
    } finally {
      measureScope.dispose()
      build.dispose()
    }
  })
})
