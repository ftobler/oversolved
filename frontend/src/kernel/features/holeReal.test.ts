// @vitest-environment node
//
// Gated real-OCC parity gate for the hole leaf (features/hole.ts). Rebuilds the
// same target box body + sketch plane + point XY entries as
// tests/wasm_harness/gen_hole_fixture.py, runs solveHole for a blind two-hole
// case, a through-all case, and a partial-skip case, and asserts the result dict
// plus the drilled body volume match Python.
//
// Skips when opencascade.js is absent. Regenerate:
//   .venv/bin/python tests/wasm_harness/gen_hole_fixture.py

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import { makeBox } from '../occ/primitives'
import { volumeOf } from '../occ/booleans'
import { Repository } from '../query'
import { solveHole } from './hole'
import type { Body } from '../types3d'
import type { OccModule, OccShape } from '../occ/occTypes'
import fixture from '../occ/__fixtures__/hole.json'

const oc = await loadOcc()

type Plane = { origin: number[]; x_axis: number[]; y_axis: number[]; normal: number[] }
type Case = {
  name: string
  box: number[]
  plane: Plane
  diameter: number
  depth_mode: string
  depth: number
  points: string[]
  xy_entries: Record<string, number[]>
  result: Record<string, unknown>
  volume: number
}
const fx = fixture as unknown as { cases: Case[] }

describe.skipIf(!oc)('solveHole (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  for (const c of fx.cases) {
    it(`${c.name}: result + drilled volume match Python`, () => {
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const repo = new Repository()
        repo.register('_pt_sk', c.plane)
        for (const [eid, xy] of Object.entries(c.xy_entries)) {
          repo.register(`sk/${eid}/xy`, { external_xy: xy })
        }
        const box = makeBox(occ, scope, c.box[0], c.box[1], c.box[2])
        const bodyStore: Record<string, Body> = {
          body_t: {
            id: 'body_t',
            created_by: 'ex_t',
            modified_by: [],
            shape: table.register(scope.detach(box), 'ex_t'),
            sketch_id: 'sk_t',
            brep_diff: null,
            profile_queries: [],
            face_lineage: {},
            edge_lineage: {},
          },
        }
        const featuresById = { sk: { entities: c.points.map((p) => ({ id: p, kind: 'point' })) } }

        const result = solveHole(
          occ,
          scope,
          table,
          {
            id: 'hole1',
            hole: {
              sketch: '@sk',
              diameter: c.diameter,
              depth_mode: c.depth_mode,
              depth: c.depth,
              direction: 'normal',
              target: 'body_t',
            },
          },
          repo,
          bodyStore,
          featuresById,
        )
        expect(result).toEqual(c.result)
        expect(volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_t.shape!))).toBeCloseTo(c.volume, 2)
      } finally {
        scope.dispose()
      }
    })
  }
})
