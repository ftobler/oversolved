// @vitest-environment node
//
// Regression for the Panel's DB9 connector outline (bugreports/mcp-practice):
// four slanted/straight lines and four r3.4 corner arcs. At the origin the loop
// cut the D shape; translated to (91,225) the area builder read the bottom-right
// corner arc as its 270 degree complement and closed the full r3.4 cylinder.
// The area builder's arc split used to wrap a tangent contact a hair below the
// arc start to the far end of its angle window; every placement must now build
// the same face, and the real kernel must give the hand area times the depth.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import type { BuildResponse } from '../../builder'
import { DisposeScope } from '../../occ/disposeScope'
import { volumeOf } from '../../occ/booleans'
import type { OccShape } from '../../occ/occTypes'
import { oc, solveBytes, extrudeTestHarness } from '../extrudeRealSupport'

// Hand area of the D outline: the chord polygon's shoelace (201.3334144) plus
// four quarter-disc segments of r3.4, each r^2/2 * (pi/2 - 1).
const DB9_AREA = 201.3334144 + 4 * (3.4 * 3.4) / 2 * (Math.PI / 2 - 1)

function db9Sketch(id: string, dx: number, dy: number) {
  const p = (x: number, y: number): [number, number] => [x + dx, y + dy]
  const arc = (c: [number, number], a0: number, a1: number): number[] => [
    c[0], c[1], 3.4, a0, a1,
  ]
  return {
    id, kind: 'sketch' as const, label: `DB9 at ${dx},${dy}`, plane: '@builtin_plane_front',
    entities: [
      { id: 'l1', kind: 'line' as const },
      { id: 'l2', kind: 'line' as const },
      { id: 'l3', kind: 'line' as const },
      { id: 'l4', kind: 'line' as const },
      { id: 'a1', kind: 'arc' as const },
      { id: 'a2', kind: 'arc' as const },
      { id: 'a3', kind: 'arc' as const },
      { id: 'a4', kind: 'arc' as const },
    ],
    initial: {
      l1: [...p(-9.438896, -2.3), ...p(-10.25, 2.3)],
      l2: [...p(-6.85, 5.7), ...p(6.85, 5.7)],
      l3: [...p(10.25, 2.3), ...p(9.438896, -2.3)],
      l4: [...p(6.038896, -5.7), ...p(-6.038896, -5.7)],
      a1: arc(p(-6.038896, -2.3), 180, 270),
      a2: arc(p(-6.85, 2.3), 90, 180),
      a3: arc(p(6.85, 2.3), 0, 90),
      a4: arc(p(6.038896, -2.3), 270, 360),
    },
    // Pinned, not coincident-chained: the loop is authored coordinate-closed,
    // and this test is about the area builder reading the authored arcs, not
    // about a solve. A `fixed` on each entity keeps every parameter at its
    // seeded value (the free DOF would otherwise let the solve rescale the
    // arcs, which is a separate concern).
    constraints: [
      { id: 'f1', kind: 'fixed' as const, target: { entity: 'l1' } },
      { id: 'f2', kind: 'fixed' as const, target: { entity: 'l2' } },
      { id: 'f3', kind: 'fixed' as const, target: { entity: 'l3' } },
      { id: 'f4', kind: 'fixed' as const, target: { entity: 'l4' } },
      { id: 'f5', kind: 'fixed' as const, target: { entity: 'a1' } },
      { id: 'f6', kind: 'fixed' as const, target: { entity: 'a2' } },
      { id: 'f7', kind: 'fixed' as const, target: { entity: 'a3' } },
      { id: 'f8', kind: 'fixed' as const, target: { entity: 'a4' } },
    ],
  }
}

function db9Spec(dx: number, dy: number) {
  return {
    features: [
      db9Sketch('sk_db9', dx, dy),
      {
        id: 'ex_db9', kind: 'extrude' as const, label: 'DB9',
        extrude: { sketch: '@sk_db9', distance: 2, direction: 'normal', operation: 'new' },
      },
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('DB9 outline (real OCC + Rust solver)', () => {
  const h = extrudeTestHarness()

  function volume(result: BuildResponse): number {
    const cp = result._build_state!.checkpoints['ex_db9']
    const shape = h.table.get<OccShape>(cp.body_store_snapshot['body_ex_db9'].shape!)
    const scope = new DisposeScope()
    try {
      return volumeOf(oc!, scope, shape)
    } finally {
      scope.dispose()
    }
  }

  for (const [dx, dy] of [[0, 0], [91, 225]]) {
    it(`extrudes the D shape at (${dx},${dy}), not the corner circle`, () => {
      const result = h.run(db9Spec(dx, dy))
      expect(h.res(result, 'ex_db9').status).toBe('ok')
      const got = volume(result)
      // A full r3.4 cylinder would read 72.63; the D shape is 429.06.
      expect(got).toBeCloseTo(DB9_AREA * 2, 3)
    })
  }
})
