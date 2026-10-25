// @vitest-environment node
//
// D1 and D4 end to end, through the real area builder: a whole-sketch extrude
// of a closed 20x20 square beside a triangle whose last joint is left open.
// A 5e-6 joint is inside the builder's vertex merge, so the triangle IS an
// area and must reach the kernel. A 2e-5 joint is beyond it: the builder never
// closes the triangle, so it is no area the user could see or pick, and the
// square extrudes clean with no partial report (the report covers referenced
// areas, not open chains).
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import type { BuildResponse } from '../../builder'
import { DisposeScope } from '../../occ/disposeScope'
import { volumeOf } from '../../occ/booleans'
import type { OccShape } from '../../occ/occTypes'
import { oc, solveBytes, extrudeTestHarness } from '../extrudeRealSupport'

const SQUARE = 20 * 20
const TRIANGLE = (20 * 15) / 2

/** Square at the origin (optional) and a triangle whose last end misses its start by `gap` in y. */
function spec(gap: number, withSquare: boolean) {
  const entities = [
    { id: 't1', kind: 'line' },
    { id: 't2', kind: 'line' },
    { id: 't3', kind: 'line' },
  ]
  const initial: Record<string, number[]> = {
    t1: [40, 0, 60, 0],
    t2: [60, 0, 50, 15],
    t3: [50, 15, 40, gap],
  }
  if (withSquare) {
    entities.push(
      { id: 's1', kind: 'line' }, { id: 's2', kind: 'line' },
      { id: 's3', kind: 'line' }, { id: 's4', kind: 'line' },
    )
    initial.s1 = [0, 0, 20, 0]
    initial.s2 = [20, 0, 20, 20]
    initial.s3 = [20, 20, 0, 20]
    initial.s4 = [0, 20, 0, 0]
  }
  return {
    features: [
      {
        id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front', entities, initial,
        // Fixed so the solve keeps the authored gap; the builder decides.
        constraints: entities.map((e, i) => ({ id: `f${i}`, kind: 'fixed', target: { entity: e.id } })),
      },
      {
        id: 'ex1', kind: 'extrude', label: 'Extrude',
        extrude: { sketch: '@sk1', distance: 2, direction: 'normal', operation: 'new' },
      },
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('square beside an open triangle (real OCC + Rust solver)', () => {
  const h = extrudeTestHarness()

  // Disjoint areas extrude to one body each (body_ex1, body_ex1_1, ...), so
  // the profile's volume is the sum over every body the feature made.
  function volume(result: BuildResponse): number {
    const store = result._build_state!.checkpoints['ex1'].body_store_snapshot
    const scope = new DisposeScope()
    try {
      let total = 0
      for (const [id, body] of Object.entries(store)) {
        if (id !== 'body_ex1' && !id.startsWith('body_ex1_')) continue
        total += volumeOf(oc!, scope, h.table.get<OccShape>(body.shape!))
      }
      return total
    } finally {
      scope.dispose()
    }
  }

  it('builds both areas when the triangle joint is inside the vertex merge', () => {
    const result = h.run(spec(5e-6, true))
    const ex = h.res(result, 'ex1')
    expect(ex.status).toBe('ok')
    expect(ex.exception).toBeUndefined()
    expect(volume(result)).toBeCloseTo((SQUARE + TRIANGLE) * 2, 2)
  })

  it('builds the square alone, ok, when the triangle never closed into an area', () => {
    const result = h.run(spec(2e-5, true))
    const ex = h.res(result, 'ex1')
    expect(ex.status).toBe('ok')
    expect(ex.exception).toBeUndefined()
    expect(volume(result)).toBeCloseTo(SQUARE * 2, 6)
  })

  it('still refuses the open triangle on its own', () => {
    const result = h.run(spec(2e-5, false))
    const ex = h.res(result, 'ex1')
    expect(ex.status).toBe('error')
    expect(String(ex.exception)).toContain('no closed profile found')
  })
})
