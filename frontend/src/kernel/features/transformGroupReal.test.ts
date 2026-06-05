// @vitest-environment node
//
// Gated real-OCC parity gate for the transform-group leaves (array.ts +
// transformMirror.ts): array / circular_array / transform / mirror. Rebuilds the
// same source box body (+ registered mirror plane) as
// tests/wasm_harness/gen_transform_fixture.py, runs the matching solver, and
// asserts the result dict + the post-op body store (per body: volume,
// created_by, modified_by) match Python.
//
// Skips when opencascade.js is absent. Regenerate:
//   .venv/bin/python tests/wasm_harness/gen_transform_fixture.py

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import { makeBoxAt, type Vec3 } from '../occ/primitives'
import { volumeOf } from '../occ/booleans'
import { Repository } from '../query'
import { solveArray, solveCircularArray } from './array'
import { solveTransform, solveMirror } from './transformMirror'
import type { Body } from '../types3d'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { HandleTable as HT } from '../occ/handleTable'
import type { DisposeScope as DS } from '../occ/disposeScope'
import fixture from '../occ/__fixtures__/transformGroup.json'

const oc = await loadOcc()

type BodyState = { volume: number | null; created_by: string; modified_by: string[] }
type BoxSpec = [number[], number[]]
type Case = {
  name: string
  kind: string
  feature_id: string
  source_spec: BoxSpec
  sub: Record<string, unknown>
  register_plane: boolean
  result: Record<string, unknown>
  store: Record<string, BodyState>
}
const fx = fixture as unknown as { cases: Case[] }

type Solver = (
  oc: OccModule, scope: DS, table: HT, feature: Record<string, unknown>, repo: Repository, store: Record<string, Body>,
) => Record<string, unknown>

const SOLVERS = {
  array: solveArray,
  circular_array: solveCircularArray,
  transform: solveTransform,
  mirror: solveMirror,
} as unknown as Record<string, Solver>

describe.skipIf(!oc)('transform-group leaves (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  for (const c of fx.cases) {
    it(`${c.name}: result + body store match Python`, () => {
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const repo = new Repository()
        if (c.register_plane) {
          repo.register('builtin_plane_front', { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1] })
        }
        const box = makeBoxAt(occ, scope, c.source_spec[0] as Vec3, c.source_spec[1][0], c.source_spec[1][1], c.source_spec[1][2])
        const bodyStore: Record<string, Body> = {
          body_s: {
            id: 'body_s',
            created_by: 'ex_s',
            modified_by: [],
            shape: table.register(scope.detach(box), 'ex_s'),
            sketch_id: 'sk_s',
            brep_diff: null,
            profile_queries: [],
            face_lineage: {},
            edge_lineage: {},
          },
        }
        const feature = { id: c.feature_id, kind: c.kind, [c.kind]: c.sub }
        const result = SOLVERS[c.kind](occ, scope, table, feature, repo, bodyStore)
        expect(result).toEqual(c.result)

        expect(Object.keys(bodyStore).sort()).toEqual(Object.keys(c.store).sort())
        for (const bid of Object.keys(c.store)) {
          const b = bodyStore[bid]
          expect(b.created_by).toBe(c.store[bid].created_by)
          expect(b.modified_by).toEqual(c.store[bid].modified_by)
          const vol = b.shape === null ? null : volumeOf(occ, scope, table.get<OccShape>(b.shape))
          if (c.store[bid].volume === null) expect(vol).toBeNull()
          else expect(vol as number).toBeCloseTo(c.store[bid].volume as number, 2)
        }
      } finally {
        scope.dispose()
      }
    })
  }
})
