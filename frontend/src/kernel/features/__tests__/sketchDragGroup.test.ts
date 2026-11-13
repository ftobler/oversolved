// @vitest-environment node
//
// The drag fast path over a rigid Group constraint. A group holds the stored
// shape and only translates, so a drag of one member must move every member by
// the same delta and deform nothing. The reference vector is the load-bearing
// part: the drag seed is the previous frame (a vertex drag deforms it on
// purpose), so the constraints must hold `feature.initial`, not the seed, or the
// group would learn each frame's deformation.
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

function groupedFeature(sketchId: string): SketchFeature {
  return {
    id: sketchId, kind: 'sketch', label: 'Grouped', plane: '@builtin_plane_front',
    entities: [{ id: 'l1', kind: 'line' }, { id: 'c1', kind: 'circle' }],
    initial: { l1: [0, 0, 10, 0], c1: [5, 2, 1.5] },
    constraints: [{ id: 'g1', kind: 'group', refs: ['$l1', '$c1'] }],
  } as unknown as SketchFeature
}

/** The group's rigid shape: the line length, the radius and the member offset. */
function shape(params: number[], offsets: { l1: number; c1: number }): number[] {
  const [x0, y0, x1, y1] = params.slice(offsets.l1, offsets.l1 + 4)
  const [cx, cy, r] = params.slice(offsets.c1, offsets.c1 + 3)
  return [
    Math.hypot(x1 - x0, y1 - y0),
    r,
    cx - x0,
    cy - y0,
  ]
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

  it('dragging one vertex translates every member and deforms nothing', () => {
    const ctx = prepareDragContext(groupedFeature('vertexDrag'), 'l1', 'end')!
    const off = offsets(ctx)
    const before = shape(ctx.params0, off)
    const result = solveSketchDrag(ctx, [...ctx.params0], [12, 3])!
    expect(result.status).toBe('underconstrained')

    const p = result.params
    // The dragged vertex moved; every member translated by that same delta.
    const dx = p[off.l1] - ctx.params0[off.l1]
    const dy = p[off.l1 + 1] - ctx.params0[off.l1 + 1]
    expect(Math.hypot(dx, dy)).toBeGreaterThan(1)
    expect(p[off.c1] - ctx.params0[off.c1]).toBeCloseTo(dx, 4)
    expect(p[off.c1 + 1] - ctx.params0[off.c1 + 1]).toBeCloseTo(dy, 4)
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
    expect(p[off.l1] - ctx.params0[off.l1]).toBeCloseTo(2, 2)
    expect(p[off.l1 + 1] - ctx.params0[off.l1 + 1]).toBeCloseTo(3, 2)
    expect(p[off.c1] - ctx.params0[off.c1]).toBeCloseTo(2, 2)
    expect(p[off.c1 + 1] - ctx.params0[off.c1 + 1]).toBeCloseTo(3, 2)
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
