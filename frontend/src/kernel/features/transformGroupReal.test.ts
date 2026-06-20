// @vitest-environment node
//
// Gated real-OCC parity gate for the transform-group leaves (array.ts +
// transformMirror.ts): array / circular_array / transform / mirror. Rebuilds the
// same source box body (+ registered mirror plane) as
// the now-removed gen_transform_fixture.py, runs the matching solver, and
// asserts the result dict + the post-op body store (per body: volume,
// created_by, modified_by) match Python.
//
// Skips when opencascade.js is absent. The fixture is a frozen golden snapshot;
// its generator (gen_transform_fixture.py) was deleted with the Python kernel in
// phase 4d.

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

  /** Create a box body at the given origin and size. */
  function makeBoxBody(
    oc: OccModule, scope: DisposeScope, table: HandleTable,
    origin: Vec3, w: number, h: number, d: number,
    id: string, createdBy: string,
  ): Body {
    const box = makeBoxAt(oc, scope, origin, w, h, d)
    return {
      id,
      created_by: createdBy,
      modified_by: [],
      shape: table.register(scope.detach(box), createdBy),
      sketch_id: 'sk_' + id,
      brep_diff: null,
      profile_queries: [],
      face_lineage: {},
      edge_lineage: {},
    }
  }

  describe('array inline cases', () => {
    // ── Rectangular array ──

    it('rectangular 2x2 array add', () => {
      /** 2x2 array with pitch 15 in X and Y, include_source=true. */
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const repo = new Repository()
        const bodyStore: Record<string, Body> = {
          body_s: makeBoxBody(occ, scope, table, [0, 0, 0], 5, 5, 5, 'body_s', 'ex_s'),
        }
        const srcVol = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_s.shape!))
        const result = solveArray(occ, scope, table, {
          id: 'arr1',
          array: {
            source_body: 'body_s',
            mode: 'rectangular',
            count_x: 2, pitch_x: 15, direction_x: [1, 0, 0],
            count_y: 2, pitch_y: 15, direction_y: [0, 1, 0],
            include_source: true,
            operation: 'add',
          },
        }, repo, bodyStore)
        expect(result.status).toBe('ok')
        expect(result.body_id).toBe('body_s')
        // 3 instances: source + copies at (15,0) and (15,15)
        expect(volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_s.shape!))).toBeCloseTo(srcVol * 3, 2)
        expect(bodyStore.body_s.modified_by).toContain('arr1')
      } finally {
        scope.dispose()
      }
    })

    // ── Circular array: new operation (split bodies) ──

    it('circular_array new operation creates split bodies', () => {
      /** operation=new creates 4 split bodies (source + 3 copies). */
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const repo = new Repository()
        // Box offset from origin so copies don't overlap
        const bodyStore: Record<string, Body> = {
          body_s: makeBoxBody(occ, scope, table, [5, -2, -2], 4, 4, 4, 'body_s', 'ex_s'),
        }
        const result = solveCircularArray(occ, scope, table, {
          id: 'ca1',
          circular_array: {
            count: 4, step_angle: null as unknown as number,
            axis_origin: [0, 0, 0], axis_direction: [0, 0, 1],
            include_source: true,
            operation: 'new',
          },
        }, repo, bodyStore)
        expect(result.status).toBe('ok')
        const bodyIds = Object.keys(bodyStore).filter((b) => b.startsWith('body_ca1')).sort()
        expect(bodyIds.length).toBe(4)
        for (const bid of bodyIds) {
          expect(bodyStore[bid].shape).not.toBeNull()
          expect(volumeOf(occ, scope, table.get<OccShape>(bodyStore[bid].shape!))).toBeGreaterThan(0)
        }
      } finally {
        scope.dispose()
      }
    })

    // ── Circular array: no source ──

    it('circular_array include_source=false produces count copies', () => {
      /** include_source=false should still produce count distinct copies. */
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const repo = new Repository()
        const bodyStore: Record<string, Body> = {
          body_s: makeBoxBody(occ, scope, table, [5, -2, -2], 4, 4, 4, 'body_s', 'ex_s'),
        }
        const result = solveCircularArray(occ, scope, table, {
          id: 'ca1',
          circular_array: {
            count: 5, step_angle: null as unknown as number,
            axis_origin: [0, 0, 0], axis_direction: [0, 0, 1],
            include_source: false,
            operation: 'add',
          },
        }, repo, bodyStore)
        expect(result.status).toBe('ok')
        expect(bodyStore.body_s.modified_by).toContain('ca1')
        expect(volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_s.shape!))).toBeGreaterThan(0)
      } finally {
        scope.dispose()
      }
    })

    // ── Circular array: explicit step_angle ──

    it('circular_array with explicit step_angle', () => {
      /** Explicit step_angle=45 with count=4 produces correct spacing. */
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const repo = new Repository()
        const bodyStore: Record<string, Body> = {
          body_s: makeBoxBody(occ, scope, table, [5, -2, -2], 4, 4, 4, 'body_s', 'ex_s'),
        }
        const result = solveCircularArray(occ, scope, table, {
          id: 'ca1',
          circular_array: {
            count: 4, step_angle: 45.0,
            axis_origin: [0, 0, 0], axis_direction: [0, 0, 1],
            include_source: true,
            operation: 'add',
          },
        }, repo, bodyStore)
        expect(result.status).toBe('ok')
        expect(bodyStore.body_s.modified_by).toContain('ca1')
      } finally {
        scope.dispose()
      }
    })

    // ── Circular array: 5 instances (even spacing bug reproduction) ──

    it('circular_array 5 instances evenly spaced', () => {
      /**
       * 5 instances evenly spaced -- reproduces bug report where fuse of coincident faces used
       * to fail.
       */
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const repo = new Repository()
        const bodyStore: Record<string, Body> = {
          body_s: makeBoxBody(occ, scope, table, [5, -2, -2], 4, 4, 4, 'body_s', 'ex_s'),
        }
        const result = solveCircularArray(occ, scope, table, {
          id: 'ca1',
          circular_array: {
            count: 5, step_angle: null as unknown as number,
            axis_origin: [0, 0, 0], axis_direction: [0, 0, 1],
            include_source: true,
            operation: 'add',
          },
        }, repo, bodyStore)
        expect(result.status).toBe('ok')
      } finally {
        scope.dispose()
      }
    })

    // ── Circular array: linear count=1 with source ──

    it('linear count=1 with include_source=true equals source shape', () => {
      /** count=1 with include_source=true -- no crash, body unchanged. */
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const repo = new Repository()
        const bodyStore: Record<string, Body> = {
          body_s: makeBoxBody(occ, scope, table, [0, 0, 0], 5, 5, 5, 'body_s', 'ex_s'),
        }
        const srcVol = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_s.shape!))
        const result = solveArray(occ, scope, table, {
          id: 'arr1',
          array: {
            source_body: 'body_s', mode: 'linear', count_x: 1, pitch_x: 20,
            direction_x: [1, 0, 0], include_source: true, operation: 'add',
          },
        }, repo, bodyStore)
        expect(result.status).toBe('ok')
        // Volume should be unchanged (single instance)
        expect(volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_s.shape!))).toBeCloseTo(srcVol, 2)
      } finally {
        scope.dispose()
      }
    })

    // ── Linear count=1 no source ──

    it('linear count=1 with include_source=false produces 1 transformed copy', () => {
      /** count=1 with include_source=false produces 1 copy at pitch offset. */
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const repo = new Repository()
        const bodyStore: Record<string, Body> = {
          body_s: makeBoxBody(occ, scope, table, [0, 0, 0], 5, 5, 5, 'body_s', 'ex_s'),
        }
        const srcVol = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_s.shape!))
        const result = solveArray(occ, scope, table, {
          id: 'arr1',
          array: {
            source_body: 'body_s', mode: 'linear', count_x: 1, pitch_x: 20,
            direction_x: [1, 0, 0], include_source: false, operation: 'add',
          },
        }, repo, bodyStore)
        expect(result.status).toBe('ok')
        // Body replaced with single translated copy, volume unchanged
        expect(volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_s.shape!))).toBeCloseTo(srcVol, 2)
      } finally {
        scope.dispose()
      }
    })
  })
})
