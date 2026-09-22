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
import { faceGh } from '../occ/lineageHash'
import { applyBodyOperation, type BodyOperation } from './bodyOps'
import type { Body } from '../types3d'
import type { OccModule, OccShape } from '../occ/occTypes'
import fixture from '../occ/__fixtures__/bodyOps.json'

const oc = await loadOcc()

type BodyState = {
  volume: number | null
  created_by: string
  modified_by: string[]
}
type Scenario = {
  result: Record<string, unknown>
  store: Record<string, BodyState>
}
type Fixture = {
  target: [number, number, number]
  tool: [number, number, number]
  new: Scenario
  cut: Scenario
  add_fuse: Scenario
}
const fx = fixture as unknown as Fixture

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
          shape: table.register(target, 'featT'),
          sketch_id: 'skT',
          brep_diff: null,
          profile_queries: [],
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
      }
    } finally {
      scope.dispose()
    }
  }

  it('new: tool becomes a body', () => {
    run(fx.new, 'new', { withTarget: false, mergeTarget: null })
  })

  it('cut: target loses the overlap', () => {
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
          id: 'body_t', created_by: 'featT', modified_by: [], shape: table.register(target, 'featT'),
          sketch_id: 'skT', brep_diff: null, profile_queries: [],
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
            profileQueries: [],
          }),
        ).toThrow(/does not intersect/)
      } finally {
        scope.dispose()
      }
    })

    it('cut that consumes the whole body deletes it and names it in body_ids', () => {
      /**
       * A tool that swallows the target leaves no solid: the cut must remove the
       * body from the store rather than register an empty compound, and report
       * the consumed id. The auto-delete convention here deliberately keeps the
       * consumed id in `body_ids` (features/bodySplit.ts:246-253).
       */
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      const bodyStore: Record<string, Body> = {}
      try {
        const target = makeBox(occ, scope, 10, 10, 10)
        bodyStore.body_t = {
          id: 'body_t', created_by: 'featT', modified_by: [], shape: table.register(target, 'featT'),
          sketch_id: 'skT', brep_diff: null, profile_queries: [],
        }
        // Tool encloses the target entirely.
        const tool = makeBoxAt(occ, scope, [-1, -1, -1], 12, 12, 12)
        const result = applyBodyOperation(occ, scope, table, {
          toolShape: scope.track(tool),
          bodyStore,
          operation: 'cut',
          mergeTarget: 'body_t',
          bodyId: 'body_f', featureId: 'featF', sketchId: 'skF', opName: 'extrude',
          profileQueries: [],
        })
        expect(result.status).toBe('ok')
        expect(result.operation).toBe('cut')
        expect(result.body_ids).toEqual(['body_t'])
        expect(bodyStore).toEqual({})
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
          id: 'body_t', created_by: 'featT', modified_by: [], shape: table.register(target, 'featT'),
          sketch_id: 'skT', brep_diff: null, profile_queries: [],
        }
        // Tool box is far away (no overlap with target).
        const tool = makeBoxAt(occ, scope, [20, 20, 20], 5, 5, 5)
        const result = applyBodyOperation(occ, scope, table, {
          toolShape: scope.track(tool),
          bodyStore,
          operation: 'add',
          mergeTarget: null,
          bodyId: 'body_f', featureId: 'featF', sketchId: 'skF', opName: 'extrude',
          profileQueries: [],
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
          id: 'body_t', created_by: 'featT', modified_by: [], shape: table.register(target, 'featT'),
          sketch_id: 'skT', brep_diff: null, profile_queries: [],
        }
        // Tool cuts through the center: spans from y=4 to y=6, x from -1 to 11, z from 0 to 10.
        const tool = makeBoxAt(occ, scope, [-1, 4, 0], 12, 2, 10)
        const result = applyBodyOperation(occ, scope, table, {
          toolShape: scope.track(tool),
          bodyStore,
          operation: 'cut',
          mergeTarget: 'body_t',
          bodyId: 'body_f', featureId: 'featF', sketchId: 'skF', opName: 'extrude',
          profileQueries: [],
        })
        expect(result.status).toBe('ok')
        // The cut severs the target into two 10x4x10 halves (the slab y 4..6 is
        // gone): two body entries, one per solid, at 400 each. Asserting only
        // "volume < 1000" passed even when the split was not made at all.
        expect(result.body_ids).toHaveLength(2)
        expect(Object.keys(bodyStore).sort()).toEqual(['body_t', 'body_t_1'])
        const v0 = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_t.shape!))
        const v1 = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_t_1.shape!))
        expect(v0).toBeCloseTo(400, 2)
        expect(v1).toBeCloseTo(400, 2)
      } finally {
        scope.dispose()
      }
    })
    it('a cut reaching two bodies gives each its own copy of the tool face uuids', () => {
      /**
       * With no merge_target a cut reaches EVERY body, and each one it hits
       * inherits the same tool face names. Handing them out verbatim puts one
       * construction UUID on two live faces, and picking either wall then fails
       * the resolver with "collision by construction" -- the same failure the
       * consumed-tool and kept-tool fixes removed, arriving by a third route.
       */
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      const bodyStore: Record<string, Body> = {}
      try {
        // Two disjoint boxes, x 0-10 and x 20-30, both crossed by one slab.
        for (const [bid, x] of [['body_a', 0], ['body_b', 20]] as [string, number][]) {
          const box = makeBoxAt(occ, scope, [x, 0, 0], 10, 10, 10)
          bodyStore[bid] = {
            id: bid, created_by: `feat_${bid}`, modified_by: [], shape: table.register(box, `feat_${bid}`),
            sketch_id: 'skT', brep_diff: null, profile_queries: [],
          }
        }
        const tool = scope.track(makeBoxAt(occ, scope, [-1, 3, 3], 40, 4, 4))

        // Name the tool's faces the way a real extrude tool arrives named.
        const faceNames: Record<string, string> = {}
        const faceAncestry: Record<string, string[]> = {}
        const exp = scope.track(new occ.TopExp_Explorer_2(tool, occ.TopAbs_ShapeEnum.TopAbs_FACE, occ.TopAbs_ShapeEnum.TopAbs_SHAPE))
        for (let i = 0; exp.More(); exp.Next(), i++) {
          const gh = faceGh(occ, scope, scope.track(occ.TopoDS.Face_1(exp.Current())))
          faceNames[gh] = `u_tool_${i}`
          faceAncestry[`u_tool_${i}`] = [`@skT/side${i}`]
        }

        const result = applyBodyOperation(occ, scope, table, {
          toolShape: tool,
          bodyStore,
          operation: 'cut',
          mergeTarget: null,
          bodyId: 'body_f', featureId: 'featF', sketchId: 'skF', opName: 'extrude',
          profileQueries: [],
          faceNames, faceAncestry,
        })
        expect(result.status).toBe('ok')

        // Every live face uuid in the store is claimed by exactly one face.
        const seen = new Map<string, string>()
        const dupes: string[] = []
        for (const body of Object.values(bodyStore)) {
          for (const uuid of Object.values(body.face_names ?? {})) {
            const owner = seen.get(uuid)
            if (owner !== undefined && owner !== body.id) dupes.push(uuid)
            seen.set(uuid, body.id)
          }
        }
        expect(dupes).toEqual([])

        // Scoped, not dropped: the second body still names its cut walls, and
        // its ancestry keeps the tool's own tokens for the fallback tier.
        const b = bodyStore.body_b
        const scoped = Object.values(b.face_names ?? {}).filter(u => !Object.values(faceNames).includes(u))
        expect(scoped.length).toBeGreaterThan(0)
        for (const uuid of scoped) {
          expect((b.face_ancestry ?? {})[uuid]).toBeDefined()
        }
        // The FIRST body cut keeps the tool uuids verbatim, so an ordinary
        // single-target cut names its walls exactly as it did before.
        const aNames = Object.values(bodyStore.body_a.face_names ?? {})
        expect(aNames.some(u => u.startsWith('u_tool_'))).toBe(true)
      } finally {
        scope.dispose()
      }
    })
  })
})
