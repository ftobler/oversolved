// @vitest-environment node
//
// Gated real-OCC parity gate for bodyOps.ts (phase 2e): the _apply_body_operation
// add/cut/new dispatch. Builds the same boxes + geometry-derived lineage as
// tests/wasm_harness/gen_bodyop_fixture.py, runs the ported applyBodyOperation,
// and asserts the result dict + the full post-op body-store state (per body:
// volume, created_by, modified_by, face/edge lineage) match Python.
//
// Skips when opencascade.js is absent. Regenerate:
//   .venv/bin/python tests/wasm_harness/gen_bodyop_fixture.py

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import { makeBox } from '../occ/primitives'
import { volumeOf } from '../occ/booleans'
import { applyBodyOperation, type BodyOperation } from './bodyOps'
import type { Body } from '../types3d'
import type { OccModule, OccShape } from '../occ/occTypes'
import fixture from '../occ/__fixtures__/bodyOps.json'

const oc = await loadOcc()

type Lineage = Record<string, string[]>
type BodyState = {
  volume: number | null
  created_by: string
  modified_by: string[]
  face_lineage: Lineage
  edge_lineage: Lineage
}
type Scenario = {
  result: Record<string, unknown>
  store: Record<string, BodyState>
  target_face_lineage?: Lineage
  tool_face_lineage: Lineage
}
type Fixture = {
  target: [number, number, number]
  tool: [number, number, number]
  new: Scenario
  cut: Scenario
  add_fuse: Scenario
}
const fx = fixture as unknown as Fixture

function sortLineage(d: Lineage): Lineage {
  const out: Lineage = {}
  for (const [k, v] of Object.entries(d)) out[k] = [...v].sort()
  return out
}

describe.skipIf(!oc)('applyBodyOperation (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  function run(
    scenario: Scenario,
    operation: BodyOperation,
    opts: { withTarget: boolean; mergeTarget: string | null },
  ): void {
    const [tx, ty, tz] = fx.target
    const [ux, uy, uz] = fx.tool
    const scope = new DisposeScope()
    const table = new HandleTable({ finalizerGuard: false })
    const bodyStore: Record<string, Body> = {}
    try {
      if (opts.withTarget) {
        const target = makeBox(occ, scope, tx, ty, tz)
        bodyStore.body_t = {
          id: 'body_t',
          created_by: 'featT',
          modified_by: [],
          shape: table.register(scope.detach(target), 'featT'),
          sketch_id: 'skT',
          brep_diff: null,
          profile_queries: [],
          face_lineage: { ...(scenario.target_face_lineage ?? {}) },
          edge_lineage: {},
        }
      }
      const tool = scope.track(makeBox(occ, scope, ux, uy, uz))

      const result = applyBodyOperation(occ, scope, table, {
        toolShape: tool,
        bodyStore,
        operation,
        mergeTarget: opts.mergeTarget,
        bodyId: 'body_f',
        featureId: 'featF',
        sketchId: 'skF',
        opName: 'extrude',
        profileQueries: ['?p'],
        faceLineage: scenario.tool_face_lineage,
      })

      // Result dict parity (drop undefined keys for a clean compare).
      const cleanResult: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(result)) if (v !== undefined) cleanResult[k] = v
      expect(cleanResult).toEqual(scenario.result)

      // Body-store parity.
      expect(Object.keys(bodyStore).sort()).toEqual(Object.keys(scenario.store).sort())
      for (const [bid, exp] of Object.entries(scenario.store)) {
        const body = bodyStore[bid]
        expect(body, `body ${bid} present`).toBeTruthy()
        expect(body.created_by).toBe(exp.created_by)
        expect(body.modified_by).toEqual(exp.modified_by)
        if (exp.volume !== null && body.shape !== null) {
          expect(volumeOf(occ, scope, table.get<OccShape>(body.shape))).toBeCloseTo(exp.volume, 3)
        }
        expect(sortLineage(body.face_lineage)).toEqual(sortLineage(exp.face_lineage))
        expect(sortLineage(body.edge_lineage)).toEqual(sortLineage(exp.edge_lineage))
      }
    } finally {
      scope.dispose()
    }
  }

  it('new: tool becomes a body with its lineage', () => {
    run(fx.new, 'new', { withTarget: false, mergeTarget: null })
  })

  it('cut: target loses the overlap, lineage transferred', () => {
    run(fx.cut, 'cut', { withTarget: true, mergeTarget: null })
  })

  it('add (fuse): tool merges into the explicit target', () => {
    run(fx.add_fuse, 'add', { withTarget: true, mergeTarget: 'body_t' })
  })
})
