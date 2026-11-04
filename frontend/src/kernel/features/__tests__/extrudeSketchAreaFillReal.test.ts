// @vitest-environment node
//
// The two sketch area builder bugs end to end through the real kernel:
//
// A. Four rectangles that share edges leave a 2 x 2 void at the centre. The
//    void lies inside no drawn loop, so the area builder publishes four
//    surfaces and the extrude is 32, not 36. An L of two touching rectangles
//    stays material because every point of it is inside at least one loop.
//
// B. A circle crossed by a closed slot keeps the circle: the circle's left
//    major arc was sampled at one midpoint, so its complement read as a
//    negative area and the existence gate dropped it. The line-closed control
//    and the offset-circle control pin that the concentric arc was never the
//    trigger.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import type { BuildResponse } from '../../builder'
import { DisposeScope } from '../../occ/disposeScope'
import { volumeOf } from '../../occ/booleans'
import type { OccShape } from '../../occ/occTypes'
import { oc, solveBytes, extrudeTestHarness } from '../extrudeRealSupport'

type Lines = { entities: { id: string; kind: 'line' }[]; initial: Record<string, number[]> }

/** The four lines of an axis-aligned rectangle, in add_rect order. */
function rectLines(prefix: string, x0: number, y0: number, x1: number, y1: number): Lines {
  const ids = ['b', 'r', 't', 'l']
  const at = [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]]
  return {
    entities: ids.map((s) => ({ id: `${prefix}${s}`, kind: 'line' as const })),
    initial: Object.fromEntries(ids.map((s, i) => [`${prefix}${s}`, at[i]])),
  }
}

function merge(...parts: Lines[]): Lines {
  return {
    entities: parts.flatMap((p) => p.entities),
    initial: Object.assign({}, ...parts.map((p) => p.initial)),
  }
}

function fixed(entities: { id: string }[]) {
  return entities.map((e, i) => ({
    id: `f${i}`, kind: 'fixed' as const, target: { entity: e.id },
  }))
}

function sketchOf(entities: { id: string; kind: string }[], initial: Record<string, number[]>) {
  return {
    id: 'sk1', kind: 'sketch' as const, plane: '@builtin_plane_front',
    entities, initial, constraints: fixed(entities),
  }
}

function specOf(entities: { id: string; kind: string }[], initial: Record<string, number[]>, depth = 1) {
  return {
    features: [
      sketchOf(entities, initial),
      {
        id: 'ex1', kind: 'extrude' as const,
        extrude: { sketch: '@sk1', distance: depth, direction: 'normal', operation: 'new' },
      },
    ],
  }
}

/** The circle plus the slot whose left cap is concentric with it. */
function slotSketch(
  circleCentre: [number, number],
  leftArc: boolean,
): { entities: { id: string; kind: string }[]; initial: Record<string, number[]> } {
  const entities: { id: string; kind: string }[] = [
    { id: 'c', kind: 'circle' },
    { id: 'l1', kind: 'line' },
    { id: 'a1', kind: 'arc' },
    { id: 'l2', kind: 'line' },
    { id: leftArc ? 'a2' : 'line2', kind: leftArc ? 'arc' : 'line' },
  ]
  const initial: Record<string, number[]> = {
    c: [circleCentre[0], circleCentre[1], 5.9],
    l1: [0, -2.5, 6.3, -2.5],
    a1: [6.3, 0, 2.5, -90, 90],
    l2: [6.3, 2.5, 0, 2.5],
  }
  initial[leftArc ? 'a2' : 'line2'] = leftArc ? [0, 0, 2.5, 90, 270] : [0, 2.5, 0, -2.5]
  return { entities, initial }
}

describe.skipIf(!oc || !solveBytes)('sketch area fill (real OCC + Rust solver)', () => {
  const h = extrudeTestHarness()

  function bodyIds(result: BuildResponse): string[] {
    const store = result._build_state!.checkpoints['ex1'].body_store_snapshot
    return Object.keys(store).filter((id) => id === 'body_ex1' || id.startsWith('body_ex1_'))
  }

  function volume(result: BuildResponse): number {
    const store = result._build_state!.checkpoints['ex1'].body_store_snapshot
    const scope = new DisposeScope()
    try {
      let total = 0
      for (const id of bodyIds(result)) {
        total += volumeOf(oc!, scope, h.table.get<OccShape>(store[id].shape!))
      }
      return total
    } finally {
      scope.dispose()
    }
  }

  it('extrudes the four-rectangle frame with its centre void empty', () => {
    const frame = merge(
      rectLines('A', 0, 0, 6, 2),
      rectLines('B', 0, 4, 6, 6),
      rectLines('C', 0, 2, 2, 4),
      rectLines('D', 4, 2, 6, 4),
    )
    const result = h.run(specOf(frame.entities, frame.initial))
    const ex = h.res(result, 'ex1')
    expect(ex.status).toBe('ok')
    expect(ex.exception).toBeUndefined()
    expect(ex.solver_warning).toBeUndefined()
    expect(volume(result)).toBeCloseTo(32, 3)
    expect(bodyIds(result)).toHaveLength(1)
  })

  it('keeps the L of two touching rectangles material', () => {
    const el = merge(
      rectLines('a', 0, 0, 2, 2),
      rectLines('b', 0, 2, 1, 4),
    )
    const result = h.run(specOf(el.entities, el.initial))
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(volume(result)).toBeCloseTo(6, 3)
  })

  it('keeps the circle crossed by a closed slot', () => {
    const { entities, initial } = slotSketch([0, 0], true)
    const result = h.run(specOf(entities, initial))
    const ex = h.res(result, 'ex1')
    expect(ex.status).toBe('ok')
    expect(ex.exception).toBeUndefined()
    expect(volume(result)).toBeCloseTo(122.0845, 3)
    expect(bodyIds(result)).toHaveLength(1)
  })

  it('gives the same union when the concentric arc is a line', () => {
    const { entities, initial } = slotSketch([0, 0], false)
    const result = h.run(specOf(entities, initial))
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(volume(result)).toBeCloseTo(122.0845, 3)
  })

  it('gives the same union when no slot arc is concentric', () => {
    const { entities, initial } = slotSketch([-1, 0], true)
    const result = h.run(specOf(entities, initial))
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(volume(result)).toBeCloseTo(127.0845, 3)
  })

  it('keeps the nested rectangle at 91 in one body', () => {
    const nested = merge(
      rectLines('out', 0, 0, 10, 10),
      rectLines('in', 3, 3, 6, 6),
    )
    const result = h.run(specOf(nested.entities, nested.initial))
    const ex = h.res(result, 'ex1')
    expect(ex.status).toBe('ok')
    expect(ex.exception).toBeUndefined()
    expect(volume(result)).toBeCloseTo(91, 3)
    expect(bodyIds(result)).toHaveLength(1)
  })
})
