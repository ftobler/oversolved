// @vitest-environment node
//
// The curve pattern through the real kernel: the copies it builds, measured.
// The placement law itself is pinned pure in curvePatternPlacement.test.ts;
// here a straight-line path must reproduce a linear pattern, a semicircle must
// turn the copies with the path, and the closed circle must reproduce a
// circular pattern, so a law that reads right and places wrong still fails.
//
// Skips when OCC.js or the sketch solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { DisposeScope } from '../../occ/disposeScope'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { shapeBndBox } from '../../occ/primitives'
import { volumeOf } from '../../occ/volume'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { BuildResponse } from '../../builder'
import type { Body } from '../../types3d'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Dict = Record<string, unknown>

/** A closed rectangle sketch: the plate and the pattern source both come from
 *  it. Free but drawn in place (the subject of this file is the pattern, not
 *  the sketch), so the underconstrained warning is not this test's business. */
function rectSketch(id: string, w: number, h: number, x0 = 0, y0 = 0): Dict {
  const points: [number, number][] = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]]
  const entities = points.map((_, i) => ({ id: `l${i}`, kind: 'line' }))
  const initial: Record<string, number[]> = {}
  const constraints: Dict[] = []
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length]
    initial[`l${i}`] = [a[0], a[1], b[0], b[1]]
    constraints.push({
      id: `c${i}`, kind: 'coincident',
      a: { entity: `l${i}`, point: 'end' },
      b: { entity: `l${(i + 1) % points.length}`, point: 'start' },
    })
    constraints.push({ id: `h${i}`, kind: a[1] === b[1] ? 'horizontal' : 'vertical', target: { entity: `l${i}` } })
  })
  return { id, kind: 'sketch', plane: '@builtin_plane_front', entities, initial, constraints }
}

/** A single straight path line on the front plane, from (x0,y0) to (x1,y1). */
function linePath(id: string, x0: number, y0: number, x1: number, y1: number): Dict {
  return {
    id, kind: 'sketch', plane: '@builtin_plane_front',
    entities: [{ id: 'p', kind: 'line' }],
    initial: { p: [x0, y0, x1, y1] },
    constraints: [],
  }
}

/** A circle path of radius r centred on the sketch origin. */
function circlePath(id: string, r: number): Dict {
  return {
    id, kind: 'sketch', plane: '@builtin_plane_front',
    entities: [{ id: 'c', kind: 'circle' }],
    initial: { c: [0, 0, r] },
    constraints: [],
  }
}

/** A semicircular arc path: centre at the origin, from 0 to 180 degrees. */
function arcPath(id: string, r: number): Dict {
  return {
    id, kind: 'sketch', plane: '@builtin_plane_front',
    entities: [{ id: 'a', kind: 'arc' }],
    initial: { a: [0, 0, r, 0, 180] },
    constraints: [],
  }
}

function extrude(id: string, sketch: string, distance: number, operation: 'new' | 'cut' = 'new', termination = 'blind'): Dict {
  return {
    id, kind: 'extrude',
    extrude: { sketch: `@${sketch}`, distance, direction: 'normal', operation, termination },
  }
}

describe.skipIf(!oc || !solveBytes)('curve pattern through the real kernel', () => {
  const h = new SharedHarness(oc!)
  const occ = oc as OccModule

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  function snapshot(r: BuildResponse, featureId: string): Record<string, Body> {
    return r._build_state!.checkpoints[featureId].body_store_snapshot as Record<string, Body>
  }

  /** The store's bodies' bounding boxes, sorted by body id so a reader can
   *  predict which copy is which. */
  function boxesOf(store: Record<string, Body>): number[][] {
    const scope = new DisposeScope()
    try {
      return Object.keys(store).sort().map((id) => {
        const box = shapeBndBox(occ, scope, h.table.get<OccShape>(store[id].shape!))
        return [...box.min, ...box.max].map((n) => {
          const rounded = Math.round(n * 1e6) / 1e6
          return rounded === 0 ? 0 : rounded
        })
      })
    } finally {
      scope.dispose()
    }
  }

  function volumeOfStore(store: Record<string, Body>): number {
    const scope = new DisposeScope()
    try {
      return Object.values(store)
        .map((body) => volumeOf(occ, scope, h.table.get<OccShape>(body.shape!)))
        .reduce((a, b) => a + b, 0)
    } finally {
      scope.dispose()
    }
  }

  const boxes = (r: BuildResponse, featureId: string): number[][] => boxesOf(snapshot(r, featureId))

  /** One body's bounding box, so a copy is named by its id instead of by the
   *  order the store happens to iterate. */
  function boxOf(r: BuildResponse, featureId: string, bodyId: string): number[] {
    const store = snapshot(r, featureId)
    expect(Object.keys(store)).toContain(bodyId)
    return boxesOf({ [bodyId]: store[bodyId] })[0]
  }

  /** A box compared within a millimetre-hundredth: the path is sampled, so a
   *  copy's station and frame are accurate to well under a micron but not
   *  bit-exact. */
  function expectBox(actual: number[], expected: number[]): void {
    expect(actual).toHaveLength(expected.length)
    actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 2))
  }

  // Every box in the store, lowest x first, compared like expectBox.
  function expectBoxes(r: BuildResponse, featureId: string, expected: number[][]): void {
    const actual = boxes(r, featureId).sort((a, b) => a[0] - b[0])
    expect(actual).toHaveLength(expected.length)
    actual.forEach((box, i) => expectBox(box, expected[i]))
  }

  it('reproduces a linear pattern along a straight line', () => {
    // A 4 x 4 x 5 block, repeated every 15 mm along a 30 mm line: the same
    // copies a linear pattern with pitch 15 would place.
    const r = h.run({
      version: 9,
      kind: 'part',
      features: [
        rectSketch('sk1', 4, 4),
        extrude('ex1', 'sk1', 5),
        linePath('skL', 0, 0, 30, 0),
        { id: 'cu1', kind: 'curve_pattern', curve_pattern: { subject: 'body', source_body: '@body_ex1', operation: 'new', count: 3, path: ['@skL'] } },
      ],
    })
    expect(h.res(r, 'cu1').status).toBe('ok')
    expectBoxes(r, 'cu1', [[0, 0, 0, 4, 4, 5], [15, 0, 0, 19, 4, 5], [30, 0, 0, 34, 4, 5]])
    expect(volumeOfStore(snapshot(r, 'cu1'))).toBeCloseTo(3 * 80, 6)
  })

  it('turns a copy with the path when the orientation is tangent', () => {
    // A 1 x 6 x 5 block at the start of a 20 mm semicircle. At 90 degrees the
    // block's long side has turned onto the radial direction, so its footprint
    // swaps 1 x 6 for 6 x 1.
    const r = h.run({
      version: 9,
      kind: 'part',
      features: [
        rectSketch('sk1', 1, 6, 20, 0),
        extrude('ex1', 'sk1', 5),
        arcPath('skA', 20),
        { id: 'cu1', kind: 'curve_pattern', curve_pattern: { subject: 'body', source_body: '@body_ex1', operation: 'new', count: 3, path: ['@skA'], orientation: 'tangent' } },
      ],
    })
    expect(h.res(r, 'cu1').status).toBe('ok')
    const [source, quarter, half] = boxes(r, 'cu1')
    expectBox(boxOf(r, 'cu1', 'body_ex1'), [20, 0, 0, 21, 6, 5])
    // At the top of the arc (0, 20) the local x axis points along -Y and the
    // local y axis along +X, so the 6 mm side is horizontal there.
    expectBox(boxOf(r, 'cu1', 'body_cu1'), [-6, 20, 0, 0, 21, 5])
    expectBox(boxOf(r, 'cu1', 'body_cu1_1'), [-21, -6, 0, -20, 0, 5])
    expect(source).toBeDefined()
    expect(quarter).toBeDefined()
    expect(half).toBeDefined()
  })

  it('keeps the source orientation when the orientation is fixed', () => {
    const r = h.run({
      version: 9,
      kind: 'part',
      features: [
        rectSketch('sk1', 1, 6, 20, 0),
        extrude('ex1', 'sk1', 5),
        arcPath('skA', 20),
        { id: 'cu1', kind: 'curve_pattern', curve_pattern: { subject: 'body', source_body: '@body_ex1', operation: 'new', count: 3, path: ['@skA'], orientation: 'fixed' } },
      ],
    })
    expect(h.res(r, 'cu1').status).toBe('ok')
    // The same 1 x 6 footprint, only carried to the station (0, 20).
    expectBox(boxOf(r, 'cu1', 'body_cu1'), [0, 20, 0, 1, 26, 5])
  })

  it('equals the tangent frame when normal_to names the plane the path lies in', () => {
    const doc = (orientation: string, extra: Dict): Record<string, unknown> => ({
      version: 9,
      kind: 'part',
      features: [
        rectSketch('sk1', 1, 6, 20, 0),
        extrude('ex1', 'sk1', 5),
        arcPath('skA', 20),
        { id: 'cu1', kind: 'curve_pattern', curve_pattern: { subject: 'body', source_body: '@body_ex1', operation: 'new', count: 4, path: ['@skA'], orientation, ...extra } },
      ],
    })
    const tangent = h.run(doc('tangent', {}))
    const normalTo = h.run(doc('normal_to', { normal_ref: '@builtin_plane_front' }))
    expect(h.res(normalTo, 'cu1').status).toBe('ok')
    expect(boxes(normalTo, 'cu1')).toEqual(boxes(tangent, 'cu1'))
  })

  it('repeats a cut feature along the path', () => {
    // A 80 x 80 x 5 plate with one 4 x 4 cut at x 30, repeated every 20 mm: the
    // plate ends with three cuts.
    const r = h.run({
      version: 9,
      kind: 'part',
      features: [
        rectSketch('sk1', 80, 80),
        extrude('ex1', 'sk1', 5),
        rectSketch('sk2', 4, 4, 30, 0),
        extrude('ex2', 'sk2', 5, 'cut', 'through_all'),
        linePath('skL', 0, 0, 40, 0),
        { id: 'cu1', kind: 'curve_pattern', curve_pattern: { subject: 'feature', source_features: ['@ex2'], count: 3, path: ['@skL'] } },
      ],
    })
    expect(h.res(r, 'cu1').status).toBe('ok')
    const store = snapshot(r, 'cu1')
    expect(Object.keys(store)).toEqual(['body_ex1'])
    expect(volumeOfStore(store)).toBeCloseTo(80 * 80 * 5 - 3 * 4 * 4 * 5, 6)
  })

  it('reproduces a circular pattern when the path is a closed circle', () => {
    const doc = (kind: 'circular_pattern' | 'curve_pattern', pathRef = '@skC'): Record<string, unknown> => ({
      version: 9,
      kind: 'part',
      features: [
        rectSketch('sk1', 2, 2, 18, -1),
        extrude('ex1', 'sk1', 5),
        circlePath('skC', 20),
        kind === 'circular_pattern'
          ? {
              id: 'pt1', kind, circular_pattern: {
                subject: 'body', source_body: '@body_ex1', operation: 'new', count: 6,
                angle: 360, equal_spacing: true,
                axis_origin: [0, 0, 0], axis_direction: [0, 0, 1],
              },
            }
          : {
              id: 'pt1', kind, curve_pattern: {
                subject: 'body', source_body: '@body_ex1', operation: 'new', count: 6, path: [pathRef],
              },
            },
      ],
    })
    const circular = h.run(doc('circular_pattern'))
    const curve = h.run(doc('curve_pattern'))
    expect(h.res(curve, 'pt1').status).toBe('ok')
    expect(boxes(curve, 'pt1')).toHaveLength(6)
    // Same six placements, to the sampling precision of the path.
    const byX = (list: number[][]): number[][] => [...list].sort((a, b) => a[0] - b[0])
    const curveBoxes = byX(boxes(curve, 'pt1'))
    const circularBoxes = byX(boxes(circular, 'pt1'))
    curveBoxes.forEach((box, i) => expectBox(box, circularBoxes[i]))

    // The circle picked as one entity walks the same loop: a lone circle's
    // geometry lives on the surface boundary, not in the split-edge list.
    const picked = h.run(doc('curve_pattern', 'entity:skC:c'))
    expect(h.res(picked, 'pt1').status).toBe('ok')
    const pickedBoxes = byX(boxes(picked, 'pt1'))
    pickedBoxes.forEach((box, i) => expectBox(box, circularBoxes[i]))
  })

  it('leaves a skipped instance out and keeps its siblings', () => {
    const r = h.run({
      version: 9,
      kind: 'part',
      features: [
        rectSketch('sk1', 4, 4),
        extrude('ex1', 'sk1', 5),
        linePath('skL', 0, 0, 40, 0),
        { id: 'cu1', kind: 'curve_pattern', curve_pattern: { subject: 'body', source_body: '@body_ex1', operation: 'new', count: 5, skip: [2, 4], path: ['@skL'] } },
      ],
    })
    expect(h.res(r, 'cu1').status).toBe('ok')
    expect(boxes(r, 'cu1').map((box) => Math.round(box[0])).sort((a, b) => a - b)).toEqual([0, 10, 30])
    expect(h.res(r, 'cu1').solver_warning).toBeUndefined()
  })

  it('makes no copy for count 1, quietly', () => {
    const r = h.run({
      version: 9,
      kind: 'part',
      features: [
        rectSketch('sk1', 4, 4),
        extrude('ex1', 'sk1', 5),
        linePath('skL', 0, 0, 40, 0),
        { id: 'cu1', kind: 'curve_pattern', curve_pattern: { subject: 'body', source_body: '@body_ex1', operation: 'add', count: 1, path: ['@skL'] } },
      ],
    })
    const res = h.res(r, 'cu1')
    expect(res.status).toBe('ok')
    expect(res.body_ids).toEqual(['body_ex1'])
    expect(res.solver_warning).toBeUndefined()
  })

  it('drops the instances distance spacing cannot fit and marks the feature partial', () => {
    const r = h.run({
      version: 9,
      kind: 'part',
      features: [
        rectSketch('sk1', 4, 4),
        extrude('ex1', 'sk1', 5),
        linePath('skL', 0, 0, 30, 0),
        {
          id: 'cu1', kind: 'curve_pattern', curve_pattern: {
            subject: 'body', source_body: '@body_ex1', operation: 'new',
            count: 5, spacing: 'distance', distance: 15, path: ['@skL'],
          },
        },
      ],
    })
    const res = h.res(r, 'cu1')
    expect(res.status).toBe('partial')
    expect(res.solver_warning).toContain('instances 3..4 run past the path end (length 30 mm)')
    expect(boxes(r, 'cu1')).toHaveLength(3)
  })

  it('refuses a path it cannot walk, by name', () => {
    const r = h.run({
      version: 9,
      kind: 'part',
      features: [
        rectSketch('sk1', 4, 4),
        extrude('ex1', 'sk1', 5),
        { id: 'cu1', kind: 'curve_pattern', curve_pattern: { subject: 'body', source_body: '@body_ex1', operation: 'new', count: 3 } },
      ],
    })
    const res = h.res(r, 'cu1')
    expect(res.status).not.toBe('ok')
    expect(String(res.exception)).toContain('requires a path reference')
  })
})
