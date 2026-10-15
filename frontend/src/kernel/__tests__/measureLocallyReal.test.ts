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
import { measureLocally, setSolveLocalsForTest } from '../solveLocally'
import { setSketchSolver, resetSketchSolver } from '../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'

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
    expect(measure!.bodyCount).toBe(1)
    expect(measure!.volume).toBeCloseTo(500, 6)
    expect(measure!.area).toBeCloseTo(400, 6)
    expect(measure!.centroid![0]).toBeCloseTo(5, 6)
    expect(measure!.centroid![1]).toBeCloseTo(5, 6)
    expect(measure!.centroid![2]).toBeCloseTo(2.5, 6)
    expect(measure!.bbox!.min.map(v => +v.toFixed(6))).toEqual([0, 0, 0])
    expect(measure!.bbox!.max.map(v => +v.toFixed(6))).toEqual([10, 10, 5])
    expect(measure!.faces).toBe(6)
    expect(measure!.edges).toBe(12)
    expect(measure!.vertices).toBe(8)
  })

  it('sums volumes and areas over two bodies and unions their AABBs', async () => {
    const measure = await measureLocally(twoBodyDoc())
    expect(measure).not.toBeNull()
    expect(measure!.bodyCount).toBe(2)
    expect(measure!.volume).toBeCloseTo(644, 6)
    // Box 1: 2*100 + 4*50 = 400. Box 2 (6x6x4): 2*36 + 4*24 = 168.
    expect(measure!.area).toBeCloseTo(568, 6)
    expect(measure!.faces).toBe(12)
    expect(measure!.edges).toBe(24)
    expect(measure!.vertices).toBe(16)
    // The union contains the first box's AABB regardless of where the second
    // one sits on the right plane.
    for (let axis = 0; axis < 3; axis++) {
      expect(measure!.bbox!.min[axis]).toBeLessThanOrEqual(1e-6)
      expect(measure!.bbox!.max[axis]).toBeGreaterThanOrEqual([10, 10, 5][axis] - 1e-6)
    }
  })

  it('reports an empty measure for a document with no solid body', async () => {
    const measure = await measureLocally({ id: 'empty', features: [rectSketch('sk1', 4, 4)] })
    expect(measure).toMatchObject({ bodyCount: 0, volume: 0, area: 0, centroid: null, bbox: null, faces: 0 })
  })
})
