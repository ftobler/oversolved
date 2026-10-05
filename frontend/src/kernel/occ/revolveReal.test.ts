// @vitest-environment node
//
// Gated real-OCC parity gate for revolveProfileWithLineage (the revolve leaf's
// brep producer). Feeds the same profile loops + axis + angle as the frozen
// golden revolve fixture through the TS port and asserts the produced solid
// volume + the profile-entity token attribution match Python.
//
// Same conversion as the extrude gate (see prismLineageReal.test.ts): the
// geom-hash face_lineage/edge_lineage output was removed, so we build with a
// createdBy and compare the token attribution that survives on the construction-
// name ancestry maps. faceAncestry matches the golden face_lineage exactly;
// edgeAncestry is a SUBSET (curved-face seam edges get no edge UUID).
//
// Skips when opencascade.js is absent. The fixture is a frozen golden snapshot.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import { volumeOf } from './booleans'
import { revolveProfileWithLineage } from './prismLineage'
import type { PlaneLike } from '../features/shared/planes'
import type { LoopEdge } from '../profileLoops'
import type { OccModule } from './occTypes'
import type { Vec3 } from './primitives'
import fixture from './__fixtures__/revolve.json'

const oc = await loadOcc()

type Lineage = Record<string, string[]>
type Case = {
  name: string
  loops: LoopEdge[][]
  plane: PlaneLike
  axis_origin: number[]
  axis_direction: number[]
  angle: number
  sketch_id: string
  volume: number
  face_lineage: Lineage
  edge_lineage: Lineage
}
const fx = fixture as unknown as { cases: Case[] }

/** Sorted multiset of the NON-EMPTY sorted token-lists (key-independent view). */
function tokenMultiset(d: Lineage): string[] {
  return Object.values(d)
    .filter((v) => v.length > 0)
    .map((v) => JSON.stringify([...v].sort()))
    .sort()
}

describe.skipIf(!oc)('revolveProfileWithLineage (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  for (const c of fx.cases) {
    it(`${c.name}: solid volume + face/edge token attribution match Python`, () => {
      const scope = new DisposeScope()
      try {
        const { solid, faceAncestry, edgeAncestry } = revolveProfileWithLineage(
          occ,
          scope,
          c.loops,
          c.plane,
          c.axis_origin as Vec3,
          c.axis_direction as Vec3,
          c.angle,
          c.sketch_id,
          'feat',
        )
        expect(volumeOf(occ, scope, solid)).toBeCloseTo(c.volume, 3)
        // Distinct token-lists: the name layer keys faces by UUID (see extrude gate).
        expect(new Set(tokenMultiset(faceAncestry))).toEqual(new Set(tokenMultiset(c.face_lineage)))
        // Subset only: curved-face seam edges get no edge UUID. See extrude gate.
        const goldenEdges = new Set(tokenMultiset(c.edge_lineage))
        for (const t of tokenMultiset(edgeAncestry)) expect(goldenEdges.has(t)).toBe(true)
      } finally {
        scope.dispose()
      }
    })
  }
})
