// @vitest-environment node
//
// Gated real-OCC parity gate for the boolean leaf (features/boolean.ts). Rebuilds
// the same target + tool box bodies as
// tests/wasm_harness/gen_boolean_solve_fixture.py, runs solveBoolean for
// union / subtract / intersect / keep-tools / subtract-split, and asserts the
// result dict plus the post-op body store (per body: volume, created_by,
// modified_by) match Python.
//
// Skips when opencascade.js is absent. Regenerate:
//   .venv/bin/python tests/wasm_harness/gen_boolean_solve_fixture.py

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import { makeBoxAt, type Vec3 } from '../occ/primitives'
import { volumeOf } from '../occ/booleans'
import { Repository } from '../query'
import { solveBoolean } from './boolean'
import type { Body } from '../types3d'
import type { OccModule, OccShape } from '../occ/occTypes'
import fixture from '../occ/__fixtures__/booleanSolve.json'

const oc = await loadOcc()

type BodyState = { volume: number | null; created_by: string; modified_by: string[] }
type BoxSpec = [number[], number[]]
type Case = {
  name: string
  operation: string
  tool_refs: string[]
  keep_tools: boolean
  target_spec: BoxSpec
  tool_specs: BoxSpec[]
  result: { status: string; body_id: string; body_ids: string[]; operation: string }
  store: Record<string, BodyState>
}
const fx = fixture as unknown as { cases: Case[] }

function bodyFromSpec(
  occ: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  id: string,
  createdBy: string,
  spec: BoxSpec,
): Body {
  const box = makeBoxAt(occ, scope, spec[0] as Vec3, spec[1][0], spec[1][1], spec[1][2])
  return {
    id,
    created_by: createdBy,
    modified_by: [],
    shape: table.register(scope.detach(box), createdBy),
    sketch_id: id === 'body_t' ? 'sk_t' : 'sk_u',
    brep_diff: null,
    profile_queries: [],
    face_lineage: {},
    edge_lineage: {},
  }
}

describe.skipIf(!oc)('solveBoolean (real OCC)', () => {
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
        const bodyStore: Record<string, Body> = {
          body_t: bodyFromSpec(occ, scope, table, 'body_t', 'ex_t', c.target_spec),
        }
        c.tool_specs.forEach((spec, i) => {
          bodyStore[`body_u${i}`] = bodyFromSpec(occ, scope, table, `body_u${i}`, `ex_u${i}`, spec)
        })

        const result = solveBoolean(
          occ,
          scope,
          table,
          { id: 'bool1', boolean: { operation: c.operation, target: 'body_t', tools: c.tool_refs, keep_tools: c.keep_tools } },
          new Repository(),
          bodyStore,
        )
        expect(result).toEqual(c.result)

        const got: Record<string, BodyState> = {}
        for (const [bid, b] of Object.entries(bodyStore)) {
          got[bid] = {
            volume: b.shape === null ? null : volumeOf(occ, scope, table.get<OccShape>(b.shape)),
            created_by: b.created_by,
            modified_by: b.modified_by,
          }
        }
        // Volumes within tolerance; structural fields exact.
        expect(Object.keys(got).sort()).toEqual(Object.keys(c.store).sort())
        for (const bid of Object.keys(c.store)) {
          expect(got[bid].created_by).toBe(c.store[bid].created_by)
          expect(got[bid].modified_by).toEqual(c.store[bid].modified_by)
          if (c.store[bid].volume === null) expect(got[bid].volume).toBeNull()
          else expect(got[bid].volume as number).toBeCloseTo(c.store[bid].volume as number, 3)
        }
      } finally {
        scope.dispose()
      }
    })
  }

  describe('boolean inline cases (ported from test_boolean.py)', () => {
    it('multiple tools are all consumed', () => {
      /** Boolean with two tools should consume both.
       *  Port of test_boolean_multiple_tools. */
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const bodyStore: Record<string, Body> = {
          body_t: bodyFromSpec(occ, scope, table, 'body_t', 'ex_t', [[0, 0, 0], [10, 10, 10]]),
          body_u0: bodyFromSpec(occ, scope, table, 'body_u0', 'ex_u0', [[0, 0, 0], [2, 2, 2]]),
          body_u1: bodyFromSpec(occ, scope, table, 'body_u1', 'ex_u1', [[3, 0, 0], [2, 2, 2]]),
        }
        const targetVol = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_t.shape!))

        const result = solveBoolean(
          occ, scope, table,
          { id: 'bool1', boolean: { operation: 'subtract', target: 'body_t', tools: ['body_u0', 'body_u1'] } },
          new Repository(),
          bodyStore,
        )
        expect(result.status).toBe('ok')
        expect(result.operation).toBe('subtract')
        // Both tools consumed
        expect('body_u0' in bodyStore).toBe(false)
        expect('body_u1' in bodyStore).toBe(false)
        // Target volume reduced
        expect(volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_t.shape!))).toBeLessThan(targetVol)
      } finally {
        scope.dispose()
      }
    })
  })
})
