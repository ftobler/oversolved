// @vitest-environment node
//
// `colinear` is a document kind the solver has no code for: partDocToSketches
// lowers it to the coincident rows (two bare lines read as the collinear row
// pair, a point and a line as point-on-line). Before that lowering it was
// accepted, stored and drawn, then dropped with no residual at all: the sketch
// reported the DOF the constraint should have removed and the geometry stayed
// wherever the seed left it (mcp-practice run
// drawing__base_fillets_rounds_r10.png, report F1).
//
// The first case is the run's minimal repro with a pinned reference line in
// place of the projected one, so it needs no B-rep kernel. Skips when the Rust
// solver build is absent.

import { describe, it, expect } from 'vitest'
import type { PartFeature, SketchFeature } from '@/types/cad'
import { loadSolver } from '../loadSolver'
import { lowerSketch } from '../lowerSketch'
import { encodeInput, decodeOutput, STATUS_NAME, type SolverOutput } from '../codec'
import { partDocToSketches } from '../partDocToSketches'

const bytes = loadSolver()

function solve(features: PartFeature[], pinned: string[] = []) {
  const { sketches, skipped } = partDocToSketches(features, [0, 0], pinned)
  expect(skipped).toHaveLength(0)
  expect(sketches).toHaveLength(1)
  expect(sketches[0].droppedConstraints).toEqual([])
  const { input, layout } = lowerSketch(sketches[0].sketch)
  expect(bytes).not.toBeNull()
  const out: SolverOutput = decodeOutput(bytes!(encodeInput(input)))
  const solved: Record<string, number[]> = {}
  for (const l of layout) solved[l.id] = out.paramsSolved.slice(l.offset, l.offset + l.size)
  return { solved, out }
}

function twoLines(constraints: SketchFeature['constraints']): PartFeature[] {
  return [{
    id: 'sk1',
    kind: 'sketch',
    plane: '@builtin_plane_front',
    entities: [{ id: 'pb', kind: 'line' }, { id: 'l1', kind: 'line' }],
    initial: { pb: [0, 0, 9, 0], l1: [2, 0.3, 5, 0.1] },
    constraints,
  }]
}

describe.skipIf(!bytes)('a colinear lowers to solver rows', () => {
  it('pins the free line onto the reference line (the bug-1 repro)', () => {
    // A projected bottom edge, a free line colinear with it, the line's length,
    // and its start offset from the edge's start. Before the lowering this
    // solved "Underconstrained: 2 degrees of freedom. Free: l1." with l1 tilted
    // off y = 0.
    const { solved, out } = solve(twoLines([
      { id: 'cl', kind: 'colinear', a: '$l1', b: '$pb' },
      { id: 'len', kind: 'length', target: '$l1', value: 4 },
      { id: 'dx', kind: 'point_distance_x', a: '$pbstart', b: '$l1start', value: 2.5, sign: 1 },
    ]), ['pb'])

    expect(STATUS_NAME[out.overallStatus]).toBe('fully_constrained')
    expect(out.diagnostics.dof).toBe(0)

    // Both endpoints land on the reference line, 2.5 along it, 4 long.
    expect(Math.abs(solved.l1[1])).toBeLessThan(1e-6)
    expect(Math.abs(solved.l1[3])).toBeLessThan(1e-6)
    expect(solved.l1[0]).toBeCloseTo(2.5, 6)
    expect(Math.hypot(solved.l1[2] - solved.l1[0], solved.l1[3] - solved.l1[1]))
      .toBeCloseTo(4, 6)
  })

  it('removes exactly two degrees of freedom between two free lines', () => {
    const without = solve(twoLines([]))
    const withColinear = solve(twoLines([{ id: 'cl', kind: 'colinear', a: '$l1', b: '$pb' }]))
    // The pair is parallel (one row) and B's start lies on A's line (one row).
    expect(withColinear.out.diagnostics.rank - without.out.diagnostics.rank).toBe(2)
    expect(without.out.diagnostics.dof - withColinear.out.diagnostics.dof).toBe(2)
    // Neither row may be redundant or dropped, or the pair would not be the
    // collinear reading the document asked for.
    expect(withColinear.out.constraintFlags[0]).toBe(0)
  })

  it('puts a point on the line through a colinear of a point and a line', () => {
    const features: PartFeature[] = [{
      id: 'sk1',
      kind: 'sketch',
      plane: '@builtin_plane_front',
      entities: [{ id: 'l1', kind: 'line' }, { id: 'p1', kind: 'point' }],
      initial: { l1: [0, 0, 10, 0], p1: [3, 2] },
      constraints: [
        { id: 'cl', kind: 'colinear', a: '$p1xy', b: '$l1' },
        { id: 'fix', kind: 'fixed', target: '$l1start', x: 0, y: 0 },
        { id: 'horiz', kind: 'horizontal', target: '$l1' },
      ],
    }]
    const { solved, out } = solve(features)
    expect(STATUS_NAME[out.overallStatus]).not.toBe('overconstrained')
    // The point's y is driven to the line's y = 0; x stays free (dof 1 for the
    // point plus the line's end).
    expect(Math.abs(solved.p1[1])).toBeLessThan(1e-6)
    expect(solved.p1[0]).toBeCloseTo(3, 6)
  })
})
