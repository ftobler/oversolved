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
//
// The fixture was deliberately re-frozen when the leaves moved onto
// features/bodySplit.ts, in two ways:
//   - every result gained `body_ids`, which these leaves did not use to emit;
//   - `circular_add` and `mirror_merge` changed STORE SHAPE. Both fuse copies
//     that never touch (4 boxes around an axis at radius 5; a box at z=[2,6]
//     mirrored to z=[-6,-2]), so Python left one body holding 4 resp. 2 solids.
//     That is the "one Parts row that is really N parts" bug, so the snapshot
//     was of wrong behaviour; it now expects 4 resp. 2 bodies of one solid each.
// Their total volumes are unchanged, which is what says the geometry did not
// move -- only its division into parts did.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import { makeBoxAt, readSolidVertices, type Vec3 } from '../occ/primitives'
import { volumeOf } from '../occ/booleans'
import { faceGh } from '../occ/lineageHash'
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
        // Direction/axis references the array leaves now require a pick for:
        // @dir_x / @dir_y feed the linear/rectangular direction queries and
        // @axis_z the circular axis query (all resolve to the former raw vectors).
        repo.register('dir_x', { start: [0, 0, 0], end: [1, 0, 0] })
        repo.register('dir_y', { start: [0, 0, 0], end: [0, 1, 0] })
        repo.register('axis_z', { start: [0, 0, 0], end: [0, 0, 1] })
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
    }
  }

  /** Axis-aligned bounding-box centre of a body's shape, for "did it move, and how far". */
  function centreOf(scope: DisposeScope, table: HandleTable, body: Body): Vec3 {
    const verts = readSolidVertices(occ, scope, table.get<OccShape>(body.shape!))
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    for (const v of verts) {
      for (let i = 0; i < 3; i++) {
        if (v[i] < lo[i]) lo[i] = v[i]
        if (v[i] > hi[i]) hi[i] = v[i]
      }
    }
    return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
  }

  function expectCentreClose(actual: Vec3, expected: Vec3) {
    for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], 4)
  }

  /**
   * Give a body construction names keyed by its faces' real geom hashes, with
   * UUIDs numbered in explorer order. Two congruent bodies named this way get
   * the SAME UUID strings, which is what makes instance disambiguation testable.
   */
  function nameFacesInOrder(scope: DisposeScope, table: HandleTable, body: Body) {
    const E = occ.TopAbs_ShapeEnum
    const shape = table.get<OccShape>(body.shape!)
    const faceNames: Record<string, string> = {}
    const faceAncestry: Record<string, string[]> = {}
    const exp = scope.track(new occ.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
    let i = 0
    for (; exp.More(); exp.Next()) {
      const gh = faceGh(occ, scope, scope.track(occ.TopoDS.Face_1(exp.Current())))
      if (gh in faceNames) continue
      const uuid = `u_face${i++}`
      faceNames[gh] = uuid
      faceAncestry[uuid] = ['@anc']
    }
    body.face_names = faceNames
    body.face_ancestry = faceAncestry
  }

  describe('transform over a list of picks', () => {
    // The pick is a LIST and the one composed Trsf is applied to every entry
    // equally. These lock the three things that only show up with N > 1: the
    // new-body id run, per-source name instancing, and the fact that ONE
    // translation moves each source by exactly that translation (not by a
    // per-source accumulation).

    it('new: every picked body gets its own copy, moved by the same translation', () => {
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const bodyStore: Record<string, Body> = {
          body_a: makeBoxBody(occ, scope, table, [0, 0, 0], 4, 4, 4, 'body_a', 'ex_a'),
          body_b: makeBoxBody(occ, scope, table, [20, 0, 0], 6, 6, 6, 'body_b', 'ex_b'),
        }
        const centreA = centreOf(scope, table, bodyStore.body_a)
        const centreB = centreOf(scope, table, bodyStore.body_b)
        const result = solveTransform(occ, scope, table, {
          id: 'tr1',
          transform: { bodies: ['body_a', 'body_b'], operation: 'new', translation: [0, 0, 50] },
        }, new Repository(), bodyStore)

        expect(result.status).toBe('ok')
        expect(result.operation).toBe('new')
        // One flat, gap-free run off the single `body_<feature>` base.
        expect(result.body_ids).toEqual(['body_tr1', 'body_tr1_1'])
        expect(result.body_id).toBe('body_tr1')
        expect(Object.keys(bodyStore).sort()).toEqual(['body_a', 'body_b', 'body_tr1', 'body_tr1_1'])
        expectCentreClose(centreOf(scope, table, bodyStore.body_tr1), [centreA[0], centreA[1], centreA[2] + 50])
        expectCentreClose(centreOf(scope, table, bodyStore.body_tr1_1), [centreB[0], centreB[1], centreB[2] + 50])
        // Sources are untouched by a "new" transform, both in place and in history.
        expectCentreClose(centreOf(scope, table, bodyStore.body_a), centreA)
        expectCentreClose(centreOf(scope, table, bodyStore.body_b), centreB)
        expect(bodyStore.body_a.modified_by).toEqual([])
        expect(bodyStore.body_b.modified_by).toEqual([])
        expect(volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_tr1.shape!))).toBeCloseTo(64, 2)
        expect(volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_tr1_1.shape!))).toBeCloseTo(216, 2)
      } finally {
        scope.dispose()
      }
    })

    it('new: each picked body gets its OWN construction UUIDs', () => {
      /** The per-source instance index is what keeps two copies of one shape
       *  from minting the same face UUIDs and colliding in the pick resolver. */
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const bodyStore: Record<string, Body> = {
          body_a: makeBoxBody(occ, scope, table, [0, 0, 0], 4, 4, 4, 'body_a', 'ex_a'),
          body_b: makeBoxBody(occ, scope, table, [20, 0, 0], 4, 4, 4, 'body_b', 'ex_b'),
        }
        // Identical geometry AND identical source UUIDs: the worst case for
        // reuse, since only the instance index can tell the two copies apart.
        for (const bid of ['body_a', 'body_b']) nameFacesInOrder(scope, table, bodyStore[bid])
        solveTransform(occ, scope, table, {
          id: 'tr1',
          transform: { bodies: ['body_a', 'body_b'], operation: 'new', translation: [0, 0, 50] },
        }, new Repository(), bodyStore)

        const uuidsA = new Set(Object.values(bodyStore.body_tr1.face_names ?? {}))
        const uuidsB = new Set(Object.values(bodyStore.body_tr1_1.face_names ?? {}))
        expect(uuidsA.size).toBeGreaterThan(0)
        expect(uuidsB.size).toBeGreaterThan(0)
        for (const u of uuidsB) expect(uuidsA.has(u)).toBe(false)
      } finally {
        scope.dispose()
      }
    })

    it('replace: every picked body moves in place and records the feature', () => {
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const bodyStore: Record<string, Body> = {
          body_a: makeBoxBody(occ, scope, table, [0, 0, 0], 4, 4, 4, 'body_a', 'ex_a'),
          body_b: makeBoxBody(occ, scope, table, [20, 0, 0], 4, 4, 4, 'body_b', 'ex_b'),
        }
        const centreA = centreOf(scope, table, bodyStore.body_a)
        const centreB = centreOf(scope, table, bodyStore.body_b)
        const result = solveTransform(occ, scope, table, {
          id: 'tr1',
          transform: { bodies: ['body_a', 'body_b'], operation: 'replace', translation: [0, 7, 0] },
        }, new Repository(), bodyStore)

        expect(result.operation).toBe('replace')
        expect(result.body_ids).toEqual(['body_a', 'body_b'])
        expect(Object.keys(bodyStore).sort()).toEqual(['body_a', 'body_b'])
        expectCentreClose(centreOf(scope, table, bodyStore.body_a), [centreA[0], centreA[1] + 7, centreA[2]])
        expectCentreClose(centreOf(scope, table, bodyStore.body_b), [centreB[0], centreB[1] + 7, centreB[2]])
        expect(bodyStore.body_a.modified_by).toContain('tr1')
        expect(bodyStore.body_b.modified_by).toContain('tr1')
      } finally {
        scope.dispose()
      }
    })

    it('one feature ref names every body that feature made', () => {
      /** Plural on purpose, like delete_body: `@ex1` after a split must not
       *  move one half and leave the other standing. */
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const bodyStore: Record<string, Body> = {
          body_ex1: makeBoxBody(occ, scope, table, [0, 0, 0], 4, 4, 4, 'body_ex1', 'ex1'),
          body_ex1_1: makeBoxBody(occ, scope, table, [20, 0, 0], 4, 4, 4, 'body_ex1_1', 'ex1'),
        }
        const centres = [centreOf(scope, table, bodyStore.body_ex1), centreOf(scope, table, bodyStore.body_ex1_1)]
        const result = solveTransform(occ, scope, table, {
          id: 'tr1', transform: { bodies: ['@ex1'], operation: 'replace', translation: [0, 0, 9] },
        }, new Repository(), bodyStore)

        expect(result.body_ids).toEqual(['body_ex1', 'body_ex1_1'])
        expectCentreClose(centreOf(scope, table, bodyStore.body_ex1), [centres[0][0], centres[0][1], centres[0][2] + 9])
        expectCentreClose(centreOf(scope, table, bodyStore.body_ex1_1), [centres[1][0], centres[1][1], centres[1][2] + 9])
      } finally {
        scope.dispose()
      }
    })

    it('two refs naming the same body move it once', () => {
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const bodyStore: Record<string, Body> = {
          body_a: makeBoxBody(occ, scope, table, [0, 0, 0], 4, 4, 4, 'body_a', 'ex_a'),
        }
        const centreA = centreOf(scope, table, bodyStore.body_a)
        const result = solveTransform(occ, scope, table, {
          id: 'tr1',
          transform: { bodies: ['body_a', '@body_a', '@ex_a'], operation: 'replace', translation: [10, 0, 0] },
        }, new Repository(), bodyStore)

        expect(result.body_ids).toEqual(['body_a'])
        expectCentreClose(centreOf(scope, table, bodyStore.body_a), [centreA[0] + 10, centreA[1], centreA[2]])
      } finally {
        scope.dispose()
      }
    })

    it('an unresolvable ref fails the feature without moving the resolvable ones', () => {
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const bodyStore: Record<string, Body> = {
          body_a: makeBoxBody(occ, scope, table, [0, 0, 0], 4, 4, 4, 'body_a', 'ex_a'),
        }
        const centreA = centreOf(scope, table, bodyStore.body_a)
        expect(() => solveTransform(occ, scope, table, {
          id: 'tr1',
          transform: { bodies: ['body_a', 'nope'], operation: 'replace', translation: [10, 0, 0] },
        }, new Repository(), bodyStore)).toThrow(/body not found/)
        expect(Object.keys(bodyStore)).toEqual(['body_a'])
        expectCentreClose(centreOf(scope, table, bodyStore.body_a), centreA)
        expect(bodyStore.body_a.modified_by).toEqual([])
      } finally {
        scope.dispose()
      }
    })
  })

  describe('array inline cases', () => {
    // ── Rectangular array ──

    it('rectangular 2x2 array add keeps the disjoint instances as separate parts', () => {
      /**
       * 2x2 array, pitch 15, include_source=true, on a 5-cube: the three
       * instances never touch, so "add" fuses them into a 3-solid compound.
       * That is 3 parts, not one 375-volume part -- this used to assert the
       * fused volume on `body_s`, i.e. the pre-bodySplit behaviour.
       */
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const repo = new Repository()
        repo.register('dir_x', { start: [0, 0, 0], end: [1, 0, 0] })
        repo.register('dir_y', { start: [0, 0, 0], end: [0, 1, 0] })
        const bodyStore: Record<string, Body> = {
          body_s: makeBoxBody(occ, scope, table, [0, 0, 0], 5, 5, 5, 'body_s', 'ex_s'),
        }
        const srcVol = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_s.shape!))
        const result = solveArray(occ, scope, table, {
          id: 'arr1',
          array: {
            source_body: 'body_s',
            mode: 'rectangular',
            count_x: 2, pitch_x: 15, direction_x_query: '@dir_x',
            count_y: 2, pitch_y: 15, direction_y_query: '@dir_y',
            include_source: true,
            operation: 'add',
          },
        }, repo, bodyStore)
        expect(result.status).toBe('ok')
        expect(result.body_id).toBe('body_s')
        // 3 instances: source + copies at (15,0) and (15,15), each its own part.
        expect(result.body_ids).toEqual(['body_s', 'body_s_1', 'body_s_2'])
        expect(Object.keys(bodyStore).sort()).toEqual(['body_s', 'body_s_1', 'body_s_2'])
        for (const bid of ['body_s', 'body_s_1', 'body_s_2']) {
          expect(volumeOf(occ, scope, table.get<OccShape>(bodyStore[bid].shape!))).toBeCloseTo(srcVol, 2)
        }
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
        repo.register('axis_z', { start: [0, 0, 0], end: [0, 0, 1] })
        // Box offset from origin so copies don't overlap
        const bodyStore: Record<string, Body> = {
          body_s: makeBoxBody(occ, scope, table, [5, -2, -2], 4, 4, 4, 'body_s', 'ex_s'),
        }
        const result = solveCircularArray(occ, scope, table, {
          id: 'ca1',
          circular_array: {
            source_body: 'body_s',
            count: 4, step_angle: null as unknown as number,
            axis: '@axis_z',
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
        repo.register('axis_z', { start: [0, 0, 0], end: [0, 0, 1] })
        const bodyStore: Record<string, Body> = {
          body_s: makeBoxBody(occ, scope, table, [5, -2, -2], 4, 4, 4, 'body_s', 'ex_s'),
        }
        const result = solveCircularArray(occ, scope, table, {
          id: 'ca1',
          circular_array: {
            source_body: 'body_s',
            count: 5, step_angle: null as unknown as number,
            axis: '@axis_z',
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
        repo.register('axis_z', { start: [0, 0, 0], end: [0, 0, 1] })
        const bodyStore: Record<string, Body> = {
          body_s: makeBoxBody(occ, scope, table, [5, -2, -2], 4, 4, 4, 'body_s', 'ex_s'),
        }
        const result = solveCircularArray(occ, scope, table, {
          id: 'ca1',
          circular_array: {
            source_body: 'body_s',
            count: 4, step_angle: 45.0,
            axis: '@axis_z',
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
        repo.register('axis_z', { start: [0, 0, 0], end: [0, 0, 1] })
        const bodyStore: Record<string, Body> = {
          body_s: makeBoxBody(occ, scope, table, [5, -2, -2], 4, 4, 4, 'body_s', 'ex_s'),
        }
        const result = solveCircularArray(occ, scope, table, {
          id: 'ca1',
          circular_array: {
            source_body: 'body_s',
            count: 5, step_angle: null as unknown as number,
            axis: '@axis_z',
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
        repo.register('dir_x', { start: [0, 0, 0], end: [1, 0, 0] })
        const bodyStore: Record<string, Body> = {
          body_s: makeBoxBody(occ, scope, table, [0, 0, 0], 5, 5, 5, 'body_s', 'ex_s'),
        }
        const srcVol = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_s.shape!))
        const result = solveArray(occ, scope, table, {
          id: 'arr1',
          array: {
            source_body: 'body_s', mode: 'linear', count_x: 1, pitch_x: 20,
            direction_x_query: '@dir_x', include_source: true, operation: 'add',
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
        repo.register('dir_x', { start: [0, 0, 0], end: [1, 0, 0] })
        const bodyStore: Record<string, Body> = {
          body_s: makeBoxBody(occ, scope, table, [0, 0, 0], 5, 5, 5, 'body_s', 'ex_s'),
        }
        const srcVol = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_s.shape!))
        const result = solveArray(occ, scope, table, {
          id: 'arr1',
          array: {
            source_body: 'body_s', mode: 'linear', count_x: 1, pitch_x: 20,
            direction_x_query: '@dir_x', include_source: false, operation: 'add',
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
