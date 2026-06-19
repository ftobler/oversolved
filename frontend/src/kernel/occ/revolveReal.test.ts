// @vitest-environment node
//
// Gated real-OCC parity gate for revolveProfileWithLineage (phase 2f, the revolve
// leaf's brep producer). Feeds the same profile loops + axis + angle as
// the now-removed gen_revolve_fixture.py through the TS port and asserts the
// produced solid volume + the face/edge lineage match Python.
//
// Same assertion split as the extrude gate: edge_lineage EXACTLY (keys + sorted
// values; edge geom hashes are purely geometric and agree cross-language),
// face_lineage as the sorted token-multiset (cylindrical-wall geom-hash keys
// depend on the OCC-computed normal and diverge across the two builds).
//
// Skips when opencascade.js is absent. The fixture is a frozen golden snapshot;
// its generator (gen_revolve_fixture.py) was deleted with the Python kernel in
// phase 4d.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import { volumeOf } from './booleans'
import { revolveProfileWithLineage } from './prismLineage'
import type { PlaneLike } from '../features/shared'
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

function sortLineage(d: Lineage): Lineage {
  const out: Lineage = {}
  for (const [k, v] of Object.entries(d)) out[k] = [...v].sort()
  return out
}

function tokenMultiset(d: Lineage): string[] {
  return Object.values(d)
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
    it(`${c.name}: solid volume + face/edge lineage match Python`, () => {
      const scope = new DisposeScope()
      try {
        const { solid, faceLineage, edgeLineage } = revolveProfileWithLineage(
          occ,
          scope,
          c.loops,
          c.plane,
          c.axis_origin as Vec3,
          c.axis_direction as Vec3,
          c.angle,
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
