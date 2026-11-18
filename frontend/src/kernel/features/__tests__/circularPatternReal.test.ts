// @vitest-environment node
//
// The circular pattern's angle law through the real kernel: equal spacing over a
// full turn and over a smaller sweep, the increment form, the centered sweep and
// Skip Instances. The pure angle arithmetic is pinned in array.test.ts; here the
// instances are built and their placement is measured, so a law that reads right
// and places wrong still fails.
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

function doc(pattern: Dict): Record<string, unknown> {
  return {
    version: 9,
    kind: 'part',
    features: [
      rectSketch('sk1', 4, 4),
      { id: 'ex1', kind: 'extrude', extrude: { sketch: '@sk1', distance: 5, direction: 'normal', operation: 'new' } },
      { id: 'cp1', kind: 'circular_pattern', circular_pattern: { subject: 'body', source_body: '@body_ex1', operation: 'new', ...pattern } },
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('circular pattern through the real kernel', () => {
  const h = new SharedHarness(oc!)
  const occ = oc as OccModule

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  function boxes(r: BuildResponse): number[][] {
    const store = r._build_state!.checkpoints.cp1.body_store_snapshot as Record<string, PartSolid>
    const scope = new DisposeScope()
    try {
      return Object.values(store).map((part) => {
        const box = shapeBndBox(occ, scope, h.table.get<OccShape>(part.shape!))
        return [...box.min, ...box.max]
      })
    } finally {
      scope.dispose()
    }
  }

  function volume(r: BuildResponse): number {
    const store = r._build_state!.checkpoints.cp1.body_store_snapshot as Record<string, PartSolid>
    const scope = new DisposeScope()
    try {
      return Object.values(store)
        .map((part) => volumeOf(occ, scope, h.table.get<OccShape>(part.shape!)))
        .reduce((a, b) => a + b, 0)
    } finally {
      scope.dispose()
    }
  }

  const axis = { axis_origin: [0, 0, 0], axis_direction: [0, 0, 1] }
  const roundBoxes = (b: number[][]): number[][] =>
    b.map((box) => box.map((n) => {
      const rounded = Math.round(n * 1e6) / 1e6
      return rounded === 0 ? 0 : rounded
    })).sort((a, b) => a[0] - b[0] || a[1] - b[1])

  it('spreads an equal-spaced full turn over 360 / count', () => {
    const r = h.run(doc({ count: 4, angle: 360, equal_spacing: true, ...axis }))
    expect(h.res(r, 'cp1').status).toBe('ok')
    // Source 0..4, then rotations by 90, 180, 270 degrees about the origin.
    expect(roundBoxes(boxes(r))).toEqual([
      [-4, -4, 0, 0, 0, 5],
      [-4, 0, 0, 0, 4, 5],
      [0, -4, 0, 4, 0, 5],
      [0, 0, 0, 4, 4, 5],
    ])
    expect(volume(r)).toBeCloseTo(4 * 80, 6)
  })

  it('puts the ends of a smaller equal-spaced sweep on the sweep ends', () => {
    const r = h.run(doc({ count: 3, angle: 180, equal_spacing: true, ...axis }))
    expect(h.res(r, 'cp1').status).toBe('ok')
    expect(boxes(r)).toHaveLength(3)
    // Instances at 0, 90 and 180 degrees.
    expect(roundBoxes(boxes(r))).toEqual([
      [-4, -4, 0, 0, 0, 5],
      [-4, 0, 0, 0, 4, 5],
      [0, 0, 0, 4, 4, 5],
    ])
  })

  it('reads the angle as the neighbour increment when equal spacing is off', () => {
    const r = h.run(doc({ count: 3, angle: 30, equal_spacing: false, ...axis }))
    expect(h.res(r, 'cp1').status).toBe('ok')
    expect(boxes(r)).toHaveLength(3)
  })

  it('spreads a centered full turn over 2 * count - 1 slots', () => {
    const r = h.run(doc({ count: 3, centered: true, ...axis }))
    expect(h.res(r, 'cp1').status).toBe('ok')
    // Five instances: the source plus +-72 and +-144 degrees.
    expect(boxes(r)).toHaveLength(5)
  })

  it('centers a smaller sweep around the source', () => {
    const r = h.run(doc({ count: 2, angle: 120, equal_spacing: true, centered: true, ...axis }))
    expect(h.res(r, 'cp1').status).toBe('ok')
    expect(boxes(r)).toHaveLength(3)
  })

  it('leaves a skipped instance out and keeps its siblings', () => {
    const r = h.run(doc({ count: 4, skip: [2], ...axis }))
    expect(h.res(r, 'cp1').status).toBe('ok')
    expect(boxes(r)).toHaveLength(3)
    expect(h.res(r, 'cp1').solver_warning).toBeUndefined()
  })

  it('makes no copy for count 1, quietly', () => {
    const r = h.run(doc({ count: 1, operation: 'add', ...axis }))
    const res = h.res(r, 'cp1')
    expect(res.status).toBe('ok')
    expect(res.body_ids).toEqual(['body_ex1'])
    expect(res.solver_warning).toBeUndefined()
  })

  it('refuses an increment that lands a copy on the source', () => {
    const r = h.run(doc({ count: 4, angle: 120, equal_spacing: false, ...axis }))
    expect(String(h.res(r, 'cp1').exception ?? h.res(r, 'cp1').status)).toContain('lands on instance 0')
  })
})
