// @vitest-environment node
//
// Gated real-OCC parity gate for prismLineage.ts (phase 2f, the extrude leaf's
// brep producer): extrudeProfileWithLineage. Feeds the same profile loops as
// the now-removed gen_extrude_fixture.py through the TS port and asserts the
// produced solid volume + the face/edge lineage match Python.
//
// edge_lineage is asserted EXACTLY (keys + sorted values): edge geometry hashes
// are derived from purely geometric quantities (center/radius/axis/endpoints) and
// agree across languages, so the keyed map is a hard parity check. face_lineage
// is asserted as the sorted multiset of token-lists: a cylindrical face's geom
// hash key depends on its OCC-computed normal, which diverges across the two OCC
// builds for curved surfaces (the curved-face normal divergence accepted in 2b).
// The edge map -- whose stable keys carry the face tokens via adjacency -- pins
// down WHICH face each token landed on, so the two assertions together are tight.
//
// Skips when opencascade.js is absent. The fixture is a frozen golden snapshot;
// its generator (gen_extrude_fixture.py) was deleted with the Python kernel in
// phase 4d.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import { volumeOf } from './booleans'
import { extrudeProfileWithLineage } from './prismLineage'
import type { PlaneLike } from '../features/shared'
import type { LoopEdge } from '../profileLoops'
import type { OccModule } from './occTypes'
import type { Vec3 } from './primitives'
import fixture from './__fixtures__/extrude.json'

const oc = await loadOcc()

type Lineage = Record<string, string[]>
type Case = {
  name: string
  loops: LoopEdge[][]
  plane: PlaneLike
  direction: number[]
  distance: number
  sketch_id: string
  volume: number
  face_lineage: Lineage
  edge_lineage: Lineage
}
const fx = fixture as unknown as { cases: Case[] }

function sortLineage(d: Lineage): Lineage {
  const out: Lineage = {}
  for (const [k, v] of Object.entries(d)) out[k] = [...v].sort()
  return out
}

/** Sorted multiset of sorted token-lists (key-independent face-lineage view). */
function tokenMultiset(d: Lineage): string[] {
  return Object.values(d)
    .map((v) => JSON.stringify([...v].sort()))
    .sort()
}

describe.skipIf(!oc)('extrudeProfileWithLineage (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  for (const c of fx.cases) {
    it(`${c.name}: solid volume + face/edge lineage match Python`, () => {
      const scope = new DisposeScope()
      try {
        const { solid, faceLineage, edgeLineage } = extrudeProfileWithLineage(
          occ,
          scope,
          c.loops,
          c.plane,
          c.direction as Vec3,
          c.distance,
          c.sketch_id,
        )
        expect(volumeOf(occ, scope, solid)).toBeCloseTo(c.volume, 3)
        expect(tokenMultiset(faceLineage)).toEqual(tokenMultiset(c.face_lineage))
        expect(sortLineage(edgeLineage)).toEqual(c.edge_lineage)
      } finally {
        scope.dispose()
      }
    })
  }
})
