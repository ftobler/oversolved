// @vitest-environment node
//
// The linear pattern's placement through the real kernel: one direction, the
// second direction's row-major grid, per-direction Centered and Skip Instances.
// The count arithmetic is pinned in array.test.ts; here the instances are built
// and their bounding boxes measured, so a grid that counts right and places
// wrong still fails.
//
// Skips when OCC.js or the sketch solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { DisposeScope } from '../../occ/disposeScope'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { shapeBndBox } from '../../occ/primitives'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { BuildResponse } from '../../builder'
import type { Body } from '../../types3d'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Dict = Record<string, unknown>

function rectSketch(id: string, w: number, h: number): Dict {
  const points: [number, number][] = [[0, 0], [w, 0], [w, h], [0, h]]
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

function doc(pattern: Dict): Record<string, unknown> {
  return {
    version: 9,
    kind: 'part',
    features: [
      rectSketch('sk1', 4, 4),
      { id: 'ex1', kind: 'extrude', extrude: { sketch: '@sk1', distance: 5, direction: 'normal', operation: 'new' } },
      { id: 'lp1', kind: 'linear_pattern', linear_pattern: { subject: 'body', source_body: '@body_ex1', operation: 'new', ...pattern } },
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('linear pattern through the real kernel', () => {
  const h = new SharedHarness(oc!)
  const occ = oc as OccModule

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  function boxes(r: BuildResponse): number[][] {
    const store = r._build_state!.checkpoints.lp1.body_store_snapshot as Record<string, Body>
    const scope = new DisposeScope()
    try {
      return Object.values(store).map((body) => {
        const box = shapeBndBox(occ, scope, h.table.get<OccShape>(body.shape!))
        return [...box.min, ...box.max]
      })
    } finally {
      scope.dispose()
    }
  }

  const round = (b: number[][]): number[][] =>
    b.map((box) => box.map((n) => {
      const rounded = Math.round(n * 1e6) / 1e6
      return rounded === 0 ? 0 : rounded
    })).sort((a, b) => a[0] - b[0] || a[1] - b[1])

  it('repeats along one direction', () => {
    const r = h.run(doc({ count: 3, pitch: 10, direction: [1, 0, 0] }))
    expect(h.res(r, 'lp1').status).toBe('ok')
    expect(round(boxes(r))).toEqual([
      [0, 0, 0, 4, 4, 5],
      [10, 0, 0, 14, 4, 5],
      [20, 0, 0, 24, 4, 5],
    ])
  })

  it('builds the second direction as a row-major grid', () => {
    const r = h.run(doc({
      count: 2, count_2: 3, pitch: 10, pitch_2: 8, second_direction: true,
      direction: [1, 0, 0], direction_2: [0, 1, 0],
    }))
    expect(h.res(r, 'lp1').status).toBe('ok')
    expect(round(boxes(r))).toEqual([
      [0, 0, 0, 4, 4, 5],
      [0, 8, 0, 4, 12, 5],
      [0, 16, 0, 4, 20, 5],
      [10, 0, 0, 14, 4, 5],
      [10, 8, 0, 14, 12, 5],
      [10, 16, 0, 14, 20, 5],
    ])
  })

  it('centers each direction on its own flag', () => {
    const r = h.run(doc({
      count: 2, count_2: 2, pitch: 10, pitch_2: 8, second_direction: true,
      centered: true, centered_2: true, direction: [1, 0, 0], direction_2: [0, 1, 0],
    }))
    expect(h.res(r, 'lp1').status).toBe('ok')
    // +-1 column and +-1 row around the source, the source included.
    expect(boxes(r)).toHaveLength(9)
  })

  it('skips a 2D cell and keeps its siblings', () => {
    const r = h.run(doc({
      count: 2, count_2: 2, pitch: 10, pitch_2: 8, second_direction: true,
      direction: [1, 0, 0], direction_2: [0, 1, 0], skip: [[1, 1]],
    }))
    expect(h.res(r, 'lp1').status).toBe('ok')
    expect(boxes(r)).toHaveLength(3)
    expect(h.res(r, 'lp1').solver_warning).toBeUndefined()
  })

  it('builds count 1 by count_2 3 as a column', () => {
    const r = h.run(doc({
      count: 1, count_2: 3, pitch: 10, pitch_2: 8, second_direction: true,
      direction: [1, 0, 0], direction_2: [0, 1, 0],
    }))
    expect(h.res(r, 'lp1').status).toBe('ok')
    expect(round(boxes(r))).toEqual([
      [0, 0, 0, 4, 4, 5],
      [0, 8, 0, 4, 12, 5],
      [0, 16, 0, 4, 20, 5],
    ])
  })

  it('makes no copy for 1x1, quietly', () => {
    const r = h.run(doc({
      count: 1, count_2: 1, pitch: 10, pitch_2: 8, second_direction: true,
      operation: 'add', direction: [1, 0, 0], direction_2: [0, 1, 0],
    }))
    const res = h.res(r, 'lp1')
    expect(res.status).toBe('ok')
    expect(res.body_ids).toEqual(['body_ex1'])
    expect(res.solver_warning).toBeUndefined()
  })
})
