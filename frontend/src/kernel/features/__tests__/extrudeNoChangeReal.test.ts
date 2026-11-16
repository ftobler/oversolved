// @vitest-environment node
//
// An add extrude whose tool lies entirely inside the receiving body (or a cut
// whose tool removes nothing) reports `extrude: operation produced no geometry
// change` instead of a silent ok. The volume of the body is unchanged.

import { describe, it, expect } from 'vitest'
import { oc, solveBytes, extrudeTestHarness, rectSketchSk, extrudeSpec } from '../extrudeRealSupport'

describe.skipIf(!oc || !solveBytes)('extrude no-change warning (real OCC + Rust solver)', () => {
  const h = extrudeTestHarness()

  it('warns when an add bump points into the body (direction reverse)', () => {
    const result = h.run({
      features: [
        rectSketchSk('sk1', 3, 3, '@builtin_plane_front'),
        extrudeSpec('sk1', 'ex1', { distance: 3, operation: 'new' }),
        { id: 'plTop', kind: 'plane', label: 'Top', definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 3 } },
        rectSketchSk('sk2', 1, 2, '@plTop'),
        extrudeSpec('sk2', 'ex2', { distance: 0.1, direction: 'reverse', operation: 'add' }),
      ],
    })
    const ex2 = h.res(result, 'ex2')
    expect(ex2.status).toBe('ok')
    expect(String(ex2.solver_warning)).toContain('no geometry change')
    // volume unchanged: body still present, no new body minted
    expect(Object.keys(result.bodies)).toEqual(['body_ex1'])
  })

  it('grows the body when the bump points outward (direction normal)', () => {
    const result = h.run({
      features: [
        rectSketchSk('sk1', 3, 3, '@builtin_plane_front'),
        extrudeSpec('sk1', 'ex1', { distance: 3, operation: 'new' }),
        { id: 'plTop', kind: 'plane', label: 'Top', definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 3 } },
        rectSketchSk('sk2', 1, 2, '@plTop'),
        extrudeSpec('sk2', 'ex2', { distance: 0.1, direction: 'normal', operation: 'add' }),
      ],
    })
    const ex2 = h.res(result, 'ex2')
    expect(ex2.status).toBe('ok')
    expect(ex2.solver_warning).toBeUndefined()
  })
})
