// @vitest-environment node
//
// Gated real-OCC parity gate for the hole leaf (features/hole.ts). Rebuilds the
// same target box body + sketch plane + point XY entries as
// the now-removed gen_hole_fixture.py, runs solveHole for a blind two-hole
// case, a through-all case, and a partial-skip case, and asserts the result dict
// plus the drilled body volume match Python.
//
// Skips when opencascade.js is absent. The fixture is a frozen golden snapshot;
// its generator (gen_hole_fixture.py) was deleted with the Python kernel in
// phase 4d.

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

  describe('hole inline cases (ported from test_hole_feature.py)', () => {
    it('reverse direction drills from opposite side', () => {
      /** Hole with direction='reverse' drills from opposite side of the target. */
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const repo = new Repository()
        repo.register('_pt_sk', { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] })
        repo.register('sk/p1/xy', { external_xy: [10, 10] })
        const box = makeBox(occ, scope, 20, 20, 10)
        const bodyStore: Record<string, Body> = {
          body_t: {
            id: 'body_t', created_by: 'ex_t', modified_by: [],
            shape: table.register(scope.detach(box), 'ex_t'),
            sketch_id: 'sk_t', brep_diff: null,
            profile_queries: [], face_lineage: {}, edge_lineage: {},
          },
        }
        const result = solveHole(occ, scope, table, {
          id: 'hole1',
          hole: { sketch: '@sk', diameter: 10, depth: 5, direction: 'reverse', target: 'body_t' },
        }, repo, bodyStore, { sk: { entities: [{ id: 'p1', kind: 'point' }] } })
        expect(result.status).toBe('ok')
        expect(result.hole_count).toBe(1)
        expect(volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_t.shape!))).toBeLessThan(20 * 20 * 10)
      } finally {
        scope.dispose()
      }
    })

    it('no target defaults to first body in store', () => {
      /**
       * When the hole spec omits a target, the hole defaults to the first body in the body
       * store.
       */
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const repo = new Repository()
        repo.register('_pt_sk', { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] })
        repo.register('sk/p1/xy', { external_xy: [5, 5] })
        const box = makeBox(occ, scope, 10, 10, 10)
        const bodyStore: Record<string, Body> = {
          body_first: {
            id: 'body_first', created_by: 'ex_first', modified_by: [],
            shape: table.register(scope.detach(box), 'ex_first'),
            sketch_id: 'sk_first', brep_diff: null,
            profile_queries: [], face_lineage: {}, edge_lineage: {},
          },
        }
        // No `target` field — should default to body_first.
        const result = solveHole(occ, scope, table, {
          id: 'hole1',
          hole: { sketch: '@sk', diameter: 4, depth: 5 },
        }, repo, bodyStore, { sk: { entities: [{ id: 'p1', kind: 'point' }] } })
        expect(result.status).toBe('ok')
        expect(result.hole_count).toBe(1)
        expect(volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_first.shape!))).toBeLessThan(1000)
      } finally {
        scope.dispose()
      }
    })

    it('partial rebuild reuses body after hole edit', () => {
      /**
       * After editing a hole parameter (e.g. depth) and rebuilding, the body from the clean
       * prefix should be reused with the hole re-drilled.
       */
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const repo = new Repository()
        repo.register('_pt_sk', { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] })
        repo.register('sk/p1/xy', { external_xy: [5, 5] })
        const box = makeBox(occ, scope, 10, 10, 10)
        const bodyStore: Record<string, Body> = {
          body_t: {
            id: 'body_t', created_by: 'ex_t', modified_by: [],
            shape: table.register(scope.detach(box), 'ex_t'),
            sketch_id: 'sk_t', brep_diff: null,
            profile_queries: [], face_lineage: {}, edge_lineage: {},
          },
        }
        // First hole: shallow.
        const r1 = solveHole(occ, scope, table, {
          id: 'hole1',
          hole: { sketch: '@sk', diameter: 4, depth: 2, target: 'body_t' },
        }, repo, bodyStore, { sk: { entities: [{ id: 'p1', kind: 'point' }] } })
        expect(r1.status).toBe('ok')
        const volAfterShallow = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_t.shape!))

        // Edit hole to be deeper: body should re-drill with less volume.
        const r2 = solveHole(occ, scope, table, {
          id: 'hole1',
          hole: { sketch: '@sk', diameter: 4, depth: 8, target: 'body_t' },
        }, repo, bodyStore, { sk: { entities: [{ id: 'p1', kind: 'point' }] } })
        expect(r2.status).toBe('ok')
        const volAfterDeep = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_t.shape!))
        // Deeper hole removes more material.
        expect(volAfterDeep).toBeLessThan(volAfterShallow)
      } finally {
        scope.dispose()
      }
    })
  })
})
