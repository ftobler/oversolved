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
import type { PartSolid } from '../../types3d'

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

function doc(pattern: Dict, width = 4, height = 4, depth = 5): Record<string, unknown> {
  return {
    version: 9,
    kind: 'part',
    features: [
      rectSketch('sk1', width, height),
      { id: 'ex1', kind: 'extrude', extrude: { sketch: '@sk1', distance: depth, direction: 'normal', operation: 'new' } },
      { id: 'lp1', kind: 'linear_pattern', linear_pattern: { subject: 'body', source_body: '@body_ex1', operation: 'new', ...pattern } },
    ],
  }
}

/** The source body alone, for the first pass that reads a pick off it. */
function bodyDoc(width: number, height: number, depth: number): Record<string, unknown> {
  return {
    version: 9, kind: 'part',
    features: [
      rectSketch('sk1', width, height),
      { id: 'ex1', kind: 'extrude', extrude: { sketch: '@sk1', distance: depth, direction: 'normal', operation: 'new' } },
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
    const store = r._build_state!.checkpoints.lp1.body_store_snapshot as Record<string, PartSolid>
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

  interface EdgeView {
    kind: string
    start?: number[]
    end?: number[]
  }

  /** The query of the source body's straight edge that runs along `axis` for
   *  `length`, so a test can name a real pick instead of a fixture string. */
  function edgeQueryOf(r: BuildResponse, axis: 0 | 1 | 2, length: number): string {
    const view = h.part(r, 'body_ex1') as { edges?: EdgeView[], edge_queries?: string[] }
    const edges = view.edges ?? []
    for (let i = 0; i < edges.length; i++) {
      const { kind, start, end } = edges[i]
      if (kind !== 'line' || start === undefined || end === undefined) continue
      const d = end.map((v, k) => v - start[k])
      if (Math.abs(d[axis] - length) > 1e-6) continue
      if (d.some((v, k) => k !== axis && Math.abs(v) > 1e-6)) continue
      return view.edge_queries?.[i] ?? ''
    }
    throw new Error(`no straight edge along ${axis} of length ${length}`)
  }

  it('directive length spaces by the picked edge, and follows it when it grows', () => {
    const probe = h.run(bodyDoc(15, 4, 5))
    const q = edgeQueryOf(probe, 0, 15)
    const r = h.run(doc({ count: 3, direction_mode: 'directive_length', direction_query: q }, 15, 4, 5))
    const res = h.res(r, 'lp1')
    expect(res.status, String(res.exception)).toBe('ok')
    expect(res.resolved_pitch).toBeCloseTo(15, 6)
    expect(round(boxes(r))).toEqual([
      [0, 0, 0, 15, 4, 5],
      [15, 0, 0, 30, 4, 5],
      [30, 0, 0, 45, 4, 5],
    ])
    // The sketch dimension grows upstream: the pattern's own spec is unchanged,
    // but the pick it reads is on the rebuilt body, so the spacing is 20 now.
    const longer = h.run(
      doc({ count: 3, direction_mode: 'directive_length', direction_query: q }, 20, 4, 5),
      { prevState: r._build_state },
    )
    expect(h.res(longer, 'lp1').resolved_pitch).toBeCloseTo(20, 6)
    expect(round(boxes(longer))).toEqual([
      [0, 0, 0, 20, 4, 5],
      [20, 0, 0, 40, 4, 5],
      [40, 0, 0, 60, 4, 5],
    ])
  })

  it('manual takes the vector as the whole step, magnitude included', () => {
    const r = h.run(doc({ count: 2, direction_mode: 'manual', direction: [10, 0, 5] }))
    expect(h.res(r, 'lp1').status).toBe('ok')
    expect(h.res(r, 'lp1').resolved_pitch).toBeCloseTo(Math.hypot(10, 5), 6)
    expect(round(boxes(r))).toEqual([
      [0, 0, 0, 4, 4, 5],
      [10, 0, 5, 14, 4, 10],
    ])
  })

  it('manual accepts an expression component through the variable table', () => {
    const r = h.run({
      version: 9,
      kind: 'part',
      features: [
        { id: 'v_w', kind: 'variable', label: 'w', variable: { expression: '20' } },
        rectSketch('sk1', 4, 4),
        { id: 'ex1', kind: 'extrude', extrude: { sketch: '@sk1', distance: 5, direction: 'normal', operation: 'new' } },
        {
          id: 'lp1', kind: 'linear_pattern',
          linear_pattern: {
            subject: 'body', source_body: '@body_ex1', operation: 'new', count: 2,
            direction_mode: 'manual', direction: ['w/2', 0, 0],
          },
        },
      ],
    })
    const res = h.res(r, 'lp1')
    expect(res.status, String(res.exception)).toBe('ok')
    expect(res.resolved_pitch).toBeCloseTo(10, 6)
    expect(round(boxes(r))).toEqual([
      [0, 0, 0, 4, 4, 5],
      [10, 0, 0, 14, 4, 5],
    ])
  })

  it('lets direction 2 run in a different mode from direction 1', () => {
    const probe = h.run(bodyDoc(4, 4, 5))
    const q2 = edgeQueryOf(probe, 1, 4)
    const r = h.run(doc({
      count: 2, count_2: 2, second_direction: true,
      direction_mode: 'manual', direction: [10, 0, 5],
      direction_2_mode: 'directive_length', direction_2_query: q2,
    }))
    const res = h.res(r, 'lp1')
    expect(res.status, String(res.exception)).toBe('ok')
    expect(res.resolved_pitch).toBeCloseTo(Math.hypot(10, 5), 6)
    expect(res.resolved_pitch_2).toBeCloseTo(4, 6)
    expect(round(boxes(r))).toEqual([
      [0, 0, 0, 4, 4, 5],
      [0, 4, 0, 4, 8, 5],
      [10, 0, 5, 14, 4, 10],
      [10, 4, 5, 14, 8, 10],
    ])
  })
})
