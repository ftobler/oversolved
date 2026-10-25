// @vitest-environment node
//
// D3 end to end: the ttt-ppp0109 cap. An r15 arc at (-45,0) sweeping 127.5 to
// 232.5 degrees (a 105 degree cap) closed by three lines whose ends were typed
// to 4 decimals, then joined to the arc by two coincidences. The report saw the
// solve hand back the 255 degree complement, so the extrude lost the cap. The
// profile must be the authored one: the chord rectangle plus the 105 degree
// circular segment, not the rectangle plus the complement's bulge.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import { DisposeScope } from '../../occ/disposeScope'
import { volumeOf } from '../../occ/booleans'
import type { OccShape } from '../../occ/occTypes'
import { oc, solveBytes, extrudeTestHarness } from '../extrudeRealSupport'

const R = 15
const SWEEP = (105 * Math.PI) / 180
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4
const onArc = (deg: number): number[] => {
  const a = (deg * Math.PI) / 180
  return [-45 + R * Math.cos(a), R * Math.sin(a)]
}
const start = onArc(127.5).map(round4)
const end = onArc(232.5).map(round4)
// The chord rectangle from x = 0 to the arc ends, plus the cap's segment.
const CAP_AREA = -start[0] * (start[1] - end[1]) + (R * R / 2) * (SWEEP - Math.sin(SWEEP))

function capSpec() {
  return {
    features: [
      {
        id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [
          { id: 'l1', kind: 'line' }, { id: 'arc', kind: 'arc' },
          { id: 'l2', kind: 'line' }, { id: 'l3', kind: 'line' },
        ],
        initial: {
          l1: [0, start[1], start[0], start[1]],
          arc: [-45, 0, R, 127.5, 232.5],
          l2: [end[0], end[1], 0, end[1]],
          l3: [0, end[1], 0, start[1]],
        },
        constraints: [
          { id: 'c1', kind: 'coincident', a: { entity: 'l1', point: 'end' }, b: { entity: 'arc', point: 'start' } },
          { id: 'c2', kind: 'coincident', a: { entity: 'arc', point: 'end' }, b: { entity: 'l2', point: 'start' } },
        ],
      },
      {
        id: 'ex1', kind: 'extrude', label: 'Extrude',
        extrude: { sketch: '@sk1', distance: 1, direction: 'normal', operation: 'new' },
      },
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('coincident cap keeps its sweep (real OCC + Rust solver)', () => {
  const h = extrudeTestHarness()

  it('extrudes the 105 degree cap, not its complement', () => {
    const result = h.run(capSpec())
    const ex = h.res(result, 'ex1')
    expect(ex.status).toBe('ok')
    const cp = result._build_state!.checkpoints['ex1']
    const shape = h.table.get<OccShape>(cp.body_store_snapshot['body_ex1'].shape!)
    const scope = new DisposeScope()
    try {
      expect(volumeOf(oc!, scope, shape)).toBeCloseTo(CAP_AREA, 2)
    } finally {
      scope.dispose()
    }
    const topo = (cp.repo_snapshot as { elements: Record<string, { surfaces: Array<{ boundary: Array<Record<string, unknown>> }> }> })
      .elements['_topo_sk1']
    const arcs = topo.surfaces.flatMap((s) => s.boundary.filter((e) => e.kind === 'arc'))
    expect(arcs).toHaveLength(1)
    const span = (arcs[0].angle_end_deg as number) - (arcs[0].angle_start_deg as number)
    expect(span).toBeCloseTo(105, 3)
  })
})
