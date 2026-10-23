// @vitest-environment node
//
// The per-body breakdown of a measure: two disjoint boxes, each with its own
// id, volume, area, centroid and bbox. The totals must be the sum of those
// parts and the ids must be the live body ids the solve reported, not a
// renumbered or positional guess.
//
// Skips when OCC.js or the Rust sketch solver is absent.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '../loadOcc'
import { measureLocally, setSolveLocalsForTest } from '@/kernel/solveLocally'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'

const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketch(id: string, width: number, height: number, plane: string) {
  return {
    id, kind: 'sketch', plane,
    entities: [
      { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
      { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
    ],
    initial: {
      bottom: [0, 0, width, 0], right: [width, 0, width, height],
      top: [width, height, 0, height], left: [0, height, 0, 0],
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
      { id: 'c9', kind: 'length', target: { entity: 'bottom' }, value: width },
      { id: 'c10', kind: 'length', target: { entity: 'left' }, value: height },
    ],
  }
}

// 10 x 10 x 5 = 500 on the front plane and 6 x 6 x 4 = 144 on the right.
function twoDisjointBoxes() {
  return {
    id: 'per-body',
    features: [
      rectSketch('sk1', 10, 10, '@builtin_plane_front'),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, direction: 'normal', operation: 'new' },
      rectSketch('sk2', 6, 6, '@builtin_plane_right'),
      { id: 'ex2', kind: 'extrude', sketch: '$sk2', distance: 4, direction: 'normal', operation: 'new' },
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('MeasureRecord.perBody (real OCC + Rust solver)', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
    setSolveLocalsForTest(async () => oc)
  })
  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('lists one entry per live body and sums to the totals', async () => {
    const measure = await measureLocally(twoDisjointBoxes())
    expect(measure).not.toBeNull()
    expect(measure!.bodies).toBe(2)
    expect(measure!.perBody.map(body => body.id)).toEqual(['body_ex1', 'body_ex2'])
    expect(measure!.perBody[0].volume).toBeCloseTo(500, 6)
    expect(measure!.perBody[1].volume).toBeCloseTo(144, 6)
    expect(measure!.perBody.reduce((sum, body) => sum + body.volume, 0)).toBeCloseTo(measure!.volume, 6)
    expect(measure!.perBody.reduce((sum, body) => sum + body.area, 0)).toBeCloseTo(measure!.area, 6)
    // Each body carries its own centroid and bbox, not the union's.
    expect(measure!.perBody[0].centroid![0]).toBeCloseTo(5, 6)
    expect(measure!.perBody[0].centroid![1]).toBeCloseTo(5, 6)
    expect(measure!.perBody[0].bbox).toEqual([0, 0, 0, 10, 10, 5])
    for (const body of measure!.perBody) {
      expect(body.centroid).not.toBeNull()
      expect(body.bbox).not.toBeNull()
    }
  })
})
