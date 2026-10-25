// @vitest-environment node
//
// bug-arc-profile D1 end to end, through the real area builder: a whole-sketch
// extrude of a 20x20 square with an r2 circle inside it that touches the
// square from inside at a tangent point. The circle is a hole whose boundary
// meets the outer boundary at a point, as KCL and CadQuery build it, so the
// profile is the square minus the full disc. One touch (a side) and two
// touches (a corner, the enclosure report) are both pinned: the second splits
// the circle into a traced subdivision, the first leaves it a standalone loop.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import type { BuildResponse } from '../../builder'
import { DisposeScope } from '../../occ/disposeScope'
import { volumeOf } from '../../occ/booleans'
import type { OccShape } from '../../occ/occTypes'
import { oc, solveBytes, extrudeTestHarness } from '../extrudeRealSupport'

const DEPTH = 2
const SQUARE = 20 * 20
const DISC = Math.PI * 2 * 2

/** The square with circles of radius 2 at `centres`, every entity fixed. */
function spec(centres: number[][]) {
  const entities: { id: string; kind: string }[] = [
    { id: 's1', kind: 'line' }, { id: 's2', kind: 'line' },
    { id: 's3', kind: 'line' }, { id: 's4', kind: 'line' },
  ]
  const initial: Record<string, number[]> = {
    s1: [0, 0, 20, 0],
    s2: [20, 0, 20, 20],
    s3: [20, 20, 0, 20],
    s4: [0, 20, 0, 0],
  }
  centres.forEach((c, i) => {
    entities.push({ id: `h${i}`, kind: 'circle' })
    initial[`h${i}`] = [c[0], c[1], 2]
  })
  return {
    features: [
      {
        id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front', entities, initial,
        // Fixed so the solve keeps the authored tangency exactly.
        constraints: entities.map((e, i) => ({ id: `f${i}`, kind: 'fixed', target: { entity: e.id } })),
      },
      {
        id: 'ex1', kind: 'extrude', label: 'Extrude',
        extrude: { sketch: '@sk1', distance: DEPTH, direction: 'normal', operation: 'new' },
      },
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('a hole tangent to the outer loop (real OCC + Rust solver)', () => {
  const h = extrudeTestHarness()

  function bodyIds(result: BuildResponse): string[] {
    const store = result._build_state!.checkpoints['ex1'].body_store_snapshot
    return Object.keys(store).filter((id) => id === 'body_ex1' || id.startsWith('body_ex1_'))
  }

  // Disjoint areas extrude to one body each, so the profile's volume is the
  // sum over every body the feature made.
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

  it('cuts a clear hole (the control)', () => {
    const result = h.run(spec([[10, 10]]))
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(volume(result)).toBeCloseTo((SQUARE - DISC) * DEPTH, 3)
  })

  it('cuts a hole tangent to one side', () => {
    const result = h.run(spec([[2, 10]]))
    const ex = h.res(result, 'ex1')
    expect(ex.status).toBe('ok')
    expect(ex.exception).toBeUndefined()
    expect(volume(result)).toBeCloseTo((SQUARE - DISC) * DEPTH, 3)
  })

  it('cuts a hole tangent to two sides in a corner', () => {
    const result = h.run(spec([[2, 2]]))
    const ex = h.res(result, 'ex1')
    expect(ex.status).toBe('ok')
    expect(ex.exception).toBeUndefined()
    expect(volume(result)).toBeCloseTo((SQUARE - DISC) * DEPTH, 3)
    // The corner pocket meets the rest of the square only along the two
    // tangent lines, so it is its own solid (one body per area that shares no
    // face with another), not a non-manifold single body.
    expect(bodyIds(result)).toHaveLength(2)
  })

  it('cuts four corner holes, the enclosure lip', () => {
    const result = h.run(spec([[2, 2], [18, 2], [2, 18], [18, 18]]))
    const ex = h.res(result, 'ex1')
    expect(ex.status).toBe('ok')
    expect(ex.exception).toBeUndefined()
    expect(volume(result)).toBeCloseTo((SQUARE - 4 * DISC) * DEPTH, 3)
    expect(bodyIds(result)).toHaveLength(5)
  })
})
