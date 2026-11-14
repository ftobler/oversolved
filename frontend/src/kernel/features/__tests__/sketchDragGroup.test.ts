// @vitest-environment node
//
// The drag fast path over a rigid Group constraint. A group holds the stored
// shape and may translate AND rotate, so a drag of one member must move every
// member by the same rigid motion and deform nothing. The reference vector is
// the load-bearing part: the drag seed is the previous frame (a vertex drag
// deforms it on purpose), so the constraints must hold `feature.initial`, not
// the seed, or the group would learn each frame's deformation.
//
// Skips when the Rust solver WASM is absent.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  prepareDragContext,
  solveSketchDrag,
  setSketchSolver,
  resetSketchSolver,
} from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import type { SketchFeature } from '@/types/cad'

const solveBytes = loadSolver()

function groupedFeature(sketchId: string, extra: SketchFeature['constraints'] = []): SketchFeature {
  return {
    id: sketchId, kind: 'sketch', label: 'Grouped', plane: '@builtin_plane_front',
    entities: [{ id: 'l1', kind: 'line' }, { id: 'c1', kind: 'circle' }],
    initial: { l1: [0, 0, 10, 0], c1: [10, 4, 1.5] },
    constraints: [{ id: 'g1', kind: 'group', refs: ['$l1', '$c1'] }, ...extra],
  } as unknown as SketchFeature
}

/** The group's rigid shape: every distance the motion must preserve. */
function shape(params: number[], offsets: { l1: number; c1: number }): number[] {
  const [x0, y0, x1, y1] = params.slice(offsets.l1, offsets.l1 + 4)
  const [cx, cy, r] = params.slice(offsets.c1, offsets.c1 + 3)
  return [
    Math.hypot(x1 - x0, y1 - y0),
    r,
    Math.hypot(cx - x0, cy - y0),
    Math.hypot(cx - x1, cy - y1),
  ]
}

/** Where the rigid motion taking the line `s0 -> e0` to `s -> e` puts `p`. */
function rigidImage(
  p: [number, number],
  s0: [number, number], e0: [number, number],
  s: [number, number], e: [number, number],
): [number, number] {
  const u0 = [e0[0] - s0[0], e0[1] - s0[1]]
  const u = [e[0] - s[0], e[1] - s[1]]
  const d = Math.hypot(u0[0], u0[1]) * Math.hypot(u[0], u[1])
  const c = (u0[0] * u[0] + u0[1] * u[1]) / d
  const sn = (u0[0] * u[1] - u0[1] * u[0]) / d
  const v = [p[0] - s0[0], p[1] - s0[1]]
  return [s[0] + c * v[0] - sn * v[1], s[1] + sn * v[0] + c * v[1]]
}

describe.skipIf(!solveBytes)('grouped sketch drag (real WASM solver)', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  afterAll(() => {
    resetSketchSolver()
  })

  function offsets(ctx: NonNullable<ReturnType<typeof prepareDragContext>>) {
    const l1 = ctx.layout.find(l => l.id === 'l1')!.offset
    const c1 = ctx.layout.find(l => l.id === 'c1')!.offset
    return { l1, c1 }
  }

  it('dragging one vertex moves the whole set rigidly and deforms nothing', () => {
    const ctx = prepareDragContext(groupedFeature('vertexDrag'), 'l1', 'end')!
    const off = offsets(ctx)
    const before = shape(ctx.params0, off)
    const result = solveSketchDrag(ctx, [...ctx.params0], [12, 3])!
    expect(result.status).toBe('underconstrained')

    const p = result.params
    const start0: [number, number] = [ctx.params0[off.l1], ctx.params0[off.l1 + 1]]
    const end0: [number, number] = [ctx.params0[off.l1 + 2], ctx.params0[off.l1 + 3]]
    const start: [number, number] = [p[off.l1], p[off.l1 + 1]]
    const end: [number, number] = [p[off.l1 + 2], p[off.l1 + 3]]
    // The dragged vertex is pulled toward the cursor (the drag weight is soft,
    // so the rigid group does not reach it exactly) and every member followed
    // the same rigid motion, turn included.
    expect(Math.hypot(end[0] - 12, end[1] - 3)).toBeLessThan(2)
    const wanted = rigidImage(
      [ctx.params0[off.c1], ctx.params0[off.c1 + 1]], start0, end0, start, end,
    )
    expect(p[off.c1]).toBeCloseTo(wanted[0], 6)
    expect(p[off.c1 + 1]).toBeCloseTo(wanted[1], 6)
    // The held shape is exactly the reference shape.
    const after = shape(p, off)
    for (let i = 0; i < before.length; i++) {
      expect(after[i]).toBeCloseTo(before[i], 9)
    }
  })

  it('dragging the edge translates the whole group', () => {
    const ctx = prepareDragContext(groupedFeature('edgeDrag'), 'l1', null)!
    const off = offsets(ctx)
    const before = shape(ctx.params0, off)
    const result = solveSketchDrag(ctx, ctx.params0, [2, 3], [2, 3])!
    const p = result.params
    // A whole-entity drag seeds the translated pose, which already satisfies
    // the group: the solve keeps it and turns nothing.
    expect(p[off.l1] - ctx.params0[off.l1]).toBeCloseTo(2, 2)
    expect(p[off.l1 + 1] - ctx.params0[off.l1 + 1]).toBeCloseTo(3, 2)
    expect(p[off.c1] - ctx.params0[off.c1]).toBeCloseTo(2, 2)
    expect(p[off.c1 + 1] - ctx.params0[off.c1 + 1]).toBeCloseTo(3, 2)
    const after = shape(p, off)
    for (let i = 0; i < before.length; i++) {
      expect(after[i]).toBeCloseTo(before[i], 9)
    }
  })

  it('turns the whole set about an anchor pinned to the origin', () => {
    // The coincident removes the translation and leaves one rotation: dragging
    // the free line end must turn the group about the pinned start.
    const feature = groupedFeature('pinnedTurn', [{
      id: 'c0', kind: 'coincident', a: '$l1start', b: '@builtin_origin',
    }])
    const ctx = prepareDragContext(feature, 'l1', 'end')!
    const off = offsets(ctx)
    const before = shape(ctx.params0, off)
    const result = solveSketchDrag(ctx, [...ctx.params0], [0, 10])!
    const p = result.params
    // The anchor stayed put and the line turned a quarter turn (the drag weight
    // is soft, so the end sits just short of the cursor).
    expect(p[off.l1]).toBeCloseTo(0, 6)
    expect(p[off.l1 + 1]).toBeCloseTo(0, 6)
    expect(Math.abs(p[off.l1 + 2])).toBeLessThan(0.1)
    expect(p[off.l1 + 3]).toBeGreaterThan(9.5)
    // The circle centre rode the same turn: (10,4) -> (-4,10).
    expect(p[off.c1]).toBeCloseTo(-4, 1)
    expect(p[off.c1 + 1]).toBeCloseTo(10, 1)
    const after = shape(p, off)
    for (let i = 0; i < before.length; i++) {
      expect(after[i]).toBeCloseTo(before[i], 9)
    }
  })

  it('two consecutive vertex drags do not drift the reference shape', () => {
    const ctx = prepareDragContext(groupedFeature('repeatDrag'), 'l1', 'end')!
    const off = offsets(ctx)
    const before = shape(ctx.params0, off)
    const first = solveSketchDrag(ctx, [...ctx.params0], [12, 3])!
    const second = solveSketchDrag(ctx, first.params, [14, -1])!
    const after = shape(second.params, off)
    for (let i = 0; i < before.length; i++) {
      expect(after[i]).toBeCloseTo(before[i], 9)
    }
    // The second drag moved the group again (the reference did not pin it).
    expect(second.params[off.l1]).not.toBeCloseTo(first.params[off.l1], 6)
  })

  it('without the reference vector the drag seed deforms the group', () => {
    // Evidence for the decision recorded in feature/group-constraint.md: the
    // drag path's x0 is the per-frame seed, so a group that read x0 would treat
    // the already-deformed seed as the shape to hold and leave it deformed.
    const ctx = prepareDragContext(groupedFeature('noReference'), 'l1', 'end')!
    const off = offsets(ctx)
    const before = shape(ctx.params0, off)
    const noReference = {
      ...ctx,
      input: { ...ctx.input, paramsReference: undefined },
    }
    const result = solveSketchDrag(noReference, [...ctx.params0], [12, 3])!
    const after = shape(result.params, off)
    expect(Math.abs(after[0] - before[0])).toBeGreaterThan(1)
  })
})
