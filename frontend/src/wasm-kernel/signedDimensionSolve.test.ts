// @vitest-environment node
//
// Real-solver check for the orientation `sign` on directional dimensions. A
// `point_distance_x` between two points is geometrically satisfiable on either
// side of the anchor: the unsigned (legacy) residual is bistable, so the solver
// may leave the points on whichever side they started. With a `sign` selector
// the *signed* gap is pinned, so b is driven to the chosen side while the
// user-facing value stays non-negative. This is the end-to-end proof that the
// sign rides through lowerSketch -> codec -> Rust residual.
//
// Skips when the Rust solver build is absent.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { loadSolver } from './loadSolver'
import { lowerSketch } from './lowerSketch'
import { encodeInput, decodeOutput } from './codec'
import { partDocToSketches } from './partDocToSketches'

const bytes = loadSolver()

function solveFeature(doc: PartDoc): Record<string, number[]> {
  const { sketches, skipped } = partDocToSketches(doc.features)
  expect(skipped).toHaveLength(0)
  expect(sketches).toHaveLength(1)
  const { input, layout } = lowerSketch(sketches[0].sketch as never)
  const out = decodeOutput(bytes!(encodeInput(input)))
  const solved: Record<string, number[]> = {}
  for (const l of layout) solved[l.id] = out.paramsSolved.slice(l.offset, l.offset + l.size)
  return solved
}

// pa is pinned at the origin (removes the global-translation gauge freedom so
// the solve is well-posed); pb starts 10 to the right. A single
// point_distance_x(value 10) with the given sign then fully determines pb.x.
function twoPointsDoc(sign?: number): PartDoc {
  return {
    features: [{
      id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'pa', kind: 'point' }, { id: 'pb', kind: 'point' }],
      initial: { pa: [0, 0], pb: [10, 5] },
      constraints: [
        { id: 'fix', kind: 'fixed', target: '$pa', x: 0, y: 0 },
        { id: 'pd', kind: 'point_distance_x', a: '$pa', b: '$pb', value: 10, ...(sign !== undefined && { sign }) },
      ],
    }],
  }
}

describe.skipIf(!bytes)('signed directional dimension', () => {
  it('sign +1 keeps b to the right (gap +10)', () => {
    const solved = solveFeature(twoPointsDoc(1))
    expect(solved.pb[0] - solved.pa[0]).toBeCloseTo(10, 3)
  })

  it('sign -1 drives b to the left (gap -10) even though it started on the right', () => {
    const solved = solveFeature(twoPointsDoc(-1))
    // The signed residual is unsatisfied at the start (gap +10 vs target -10),
    // so the solver flips b to the other side.
    expect(solved.pb[0] - solved.pa[0]).toBeCloseTo(-10, 3)
  })

  it('without a sign the legacy magnitude holds the starting (right) side', () => {
    const solved = solveFeature(twoPointsDoc())
    // |gap| == 10, and with the points starting on the right the solver has no
    // reason to flip them.
    expect(Math.abs(solved.pb[0] - solved.pa[0])).toBeCloseTo(10, 3)
    expect(solved.pb[0] - solved.pa[0]).toBeGreaterThan(0)
  })
})
