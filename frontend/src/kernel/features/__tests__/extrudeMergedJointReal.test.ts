// @vitest-environment node
//
// D4: closing a loop by coordinates must not need more digits than the document
// keeps. The area builder merges two endpoints within TOL_TOPOLOGY_MERGE (1e-5)
// into one vertex; the loop assembler used to re-chain them by coordinate at
// TOL_LOOP_CLOSURE (1e-6) and drop the area the user could see. It now chains
// from the merged vertex, so a hand-typed gap under 1e-5 builds the analytic
// shape. A 1e-3 gap is still genuinely open and still refuses.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import { DisposeScope } from '../../occ/disposeScope'
import { volumeOf } from '../../occ/booleans'
import type { OccShape } from '../../occ/occTypes'
import { oc, solveBytes, extrudeTestHarness } from '../extrudeRealSupport'

const HALF_DISC = (Math.PI * 10 * 10) / 2

/**
 * A half disc: the r10 arc from 0 to 180 degrees, closed by a line whose ends
 * miss the arc's by `gap`. Both entities are fixed so the solve cannot move the
 * authored gap; the area builder is what has to merge (or not).
 */
function halfDiscSpec(gap: number) {
  return {
    features: [
      {
        id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [
          { id: 'arc', kind: 'arc' },
          { id: 'chord', kind: 'line' },
        ],
        initial: {
          arc: [0, 0, 10, 0, 180],
          chord: [-10, gap, 10, -gap],
        },
        constraints: [
          { id: 'f1', kind: 'fixed', target: { entity: 'arc' } },
          { id: 'f2', kind: 'fixed', target: { entity: 'chord' } },
        ],
      },
      {
        id: 'ex1', kind: 'extrude', label: 'Extrude',
        extrude: { sketch: '@sk1', distance: 2, direction: 'normal', operation: 'new' },
      },
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('merged sketch joints (real OCC + Rust solver)', () => {
  const h = extrudeTestHarness()

  it('builds a loop whose joints are 9e-6 apart', () => {
    const result = h.run(halfDiscSpec(9e-6))
    expect(h.res(result, 'ex1').status).toBe('ok')
    const cp = result._build_state!.checkpoints['ex1']
    const shape = h.table.get<OccShape>(cp.body_store_snapshot['body_ex1'].shape!)
    const scope = new DisposeScope()
    try {
      expect(volumeOf(oc!, scope, shape)).toBeCloseTo(HALF_DISC * 2, 3)
    } finally {
      scope.dispose()
    }
  })

  it('still refuses a genuinely open 1e-3 joint', () => {
    const result = h.run(halfDiscSpec(1e-3))
    const ex = h.res(result, 'ex1')
    expect(ex.status).not.toBe('ok')
    expect(String(ex.exception)).toContain('no closed profile found')
  })
})
