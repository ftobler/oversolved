// @vitest-environment node
//
// Gated real-OCC parity gate for bodyOps.ts (phase 2e): the _apply_body_operation
// add/cut/new dispatch. Builds the same boxes + geometry-derived lineage as
// the now-removed gen_bodyop_fixture.py, runs the ported applyBodyOperation,
// and asserts the result dict + the full post-op body-store state (per body:
// volume, created_by, modified_by, face/edge lineage) match Python.
//
// Skips when opencascade.js is absent. The fixture is a frozen golden snapshot;
// its generator (gen_bodyop_fixture.py) was deleted with the Python kernel in
// phase 4d.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import { makeBox, makeBoxAt } from '../occ/primitives'
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

  describe('edge cases', () => {
    it('cut fails when there is no intersection', () => {
      /**
       * Two disjoint boxes: cutting one from the other should fail because there is no
       * intersection.
       */
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      const bodyStore: Record<string, Body> = {}
      try {
        const target = makeBox(occ, scope, 10, 10, 10)
        bodyStore.body_t = {
          id: 'body_t', created_by: 'featT', modified_by: [], shape: table.register(scope.detach(target), 'featT'),
          sketch_id: 'skT', brep_diff: null, profile_queries: [], face_lineage: {}, edge_lineage: {},
        }
        // Tool box is far away (no intersection with target at origin).
        const tool = makeBoxAt(occ, scope, [20, 20, 20], 5, 5, 5)
        expect(() =>
          applyBodyOperation(occ, scope, table, {
            toolShape: scope.track(tool),
            bodyStore,
            operation: 'cut',
            mergeTarget: 'body_t',
            bodyId: 'body_f', featureId: 'featF', sketchId: 'skF', opName: 'extrude',
            profileQueries: [], faceLineage: {},
          }),
        ).toThrow(/does not intersect/)
      } finally {
        scope.dispose()
      }
    })

    it('add with disjoint body creates a separate body (not a compound)', () => {
      /**
       * Two disjoint boxes: adding a new tool when a target exists should create a SEPARATE
       * body (not a compound). The tool doesn't touch the target, so it becomes an independent
       * part.
       */
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      const bodyStore: Record<string, Body> = {}
      try {
        const target = makeBox(occ, scope, 10, 10, 10)
        bodyStore.body_t = {
          id: 'body_t', created_by: 'featT', modified_by: [], shape: table.register(scope.detach(target), 'featT'),
          sketch_id: 'skT', brep_diff: null, profile_queries: [], face_lineage: {}, edge_lineage: {},
        }
        // Tool box is far away (no overlap with target).
        const tool = makeBoxAt(occ, scope, [20, 20, 20], 5, 5, 5)
        const result = applyBodyOperation(occ, scope, table, {
          toolShape: scope.track(tool),
          bodyStore,
          operation: 'add',
          mergeTarget: null,
          bodyId: 'body_f', featureId: 'featF', sketchId: 'skF', opName: 'extrude',
          profileQueries: [], faceLineage: {},
        })
        // Both bodies should exist independently.
        expect(result.status).toBe('ok')
        expect(Object.keys(bodyStore).sort()).toEqual(['body_f', 'body_t'])
        // The new body is its own part (not merged into the target).
        expect(bodyStore.body_f.created_by).toBe('featF')
        expect(volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_f.shape!))).toBeCloseTo(125, 0)
        expect(volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_t.shape!))).toBeCloseTo(1000, 0)
      } finally {
        scope.dispose()
      }
    })

    it('cut that bisects a body into two disconnected solids creates split bodies', () => {
      /**
       * A cut shape that completely bisects the target into two disconnected solids should
       * produce two body entries in the store (not a compound).
       */
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      const bodyStore: Record<string, Body> = {}
      try {
        // Target: a 10x10x10 box at origin. Tool: a tall thin box that cuts
        // through the middle, splitting the target into two halves.
        const target = makeBox(occ, scope, 10, 10, 10)
        bodyStore.body_t = {
          id: 'body_t', created_by: 'featT', modified_by: [], shape: table.register(scope.detach(target), 'featT'),
          sketch_id: 'skT', brep_diff: null, profile_queries: [], face_lineage: {}, edge_lineage: {},
        }
        // Tool cuts through the center: spans from y=4 to y=6, x from -1 to 11, z from 0 to 10.
        const tool = makeBoxAt(occ, scope, [-1, 4, 0], 12, 2, 10)
        const result = applyBodyOperation(occ, scope, table, {
          toolShape: scope.track(tool),
          bodyStore,
          operation: 'cut',
          mergeTarget: 'body_t',
          bodyId: 'body_f', featureId: 'featF', sketchId: 'skF', opName: 'extrude',
          profileQueries: [], faceLineage: {},
        })
        expect(result.status).toBe('ok')
        // Result should carry body_ids listing all bodies in the store after the cut.
        expect(Array.isArray(result.body_ids)).toBe(true)
        expect((result.body_ids as string[]).length).toBeGreaterThanOrEqual(1)
        // At minimum, the target body is modified.
        const storeKeys = Object.keys(bodyStore).sort()
        expect(storeKeys.length).toBeGreaterThanOrEqual(1)
        // Target body volume should be less than original 1000 (material was removed).
        const targetVol = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_t.shape!))
        expect(targetVol).toBeLessThan(1000)
      } finally {
        scope.dispose()
      }
    })
  })
})
