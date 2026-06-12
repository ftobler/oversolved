// @vitest-environment node
//
// Slice 4 end-to-end: the REAL Rust area builder emits a curve-curve crossing,
// and reconcileMaterializedContacts makes the topology lean on a materialized
// point sitting there -- the inferred crossing yields to the real point's
// identity. Skips when the Rust topology build is absent.

import { describe, it, expect } from 'vitest'
import { detectTopology, topologyAvailable } from './topologyTestUtil'
import { reconcileMaterializedContacts } from './topologyDecorate'

describe.skipIf(!topologyAvailable)('reconcileMaterializedContacts (real topology)', () => {
  // A line across the x-axis through a circle centred at the origin: the area
  // builder crosses them at (5,0) and (-5,0).
  const richGeom = {
    ln:   { start: [-10, 0], end: [10, 0] },
    circ: { center: [0, 0], radius: 5 },
  }

  it('the builder emits both crossings; reconcile drops the one a point owns', () => {
    const topo = detectTopology(richGeom, 'sk')
    const xs = Object.values(topo.intersection_points).map(p => p.x).sort((a, b) => a - b)
    expect(xs).toEqual([-5, 5])

    // Materialize a point at (5,0): that crossing is now the point's identity.
    const reconciled = reconcileMaterializedContacts(topo, [[5, 0]])
    const left = Object.values(reconciled.intersection_points)
    expect(left).toHaveLength(1)
    expect(left[0].x).toBeCloseTo(-5, 6)
  })
})
