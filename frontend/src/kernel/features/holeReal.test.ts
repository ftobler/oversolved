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
import { makeBox, makeBoxAt, makeCylinder, type Vec3 } from '../occ/primitives'
import { volumeOf, booleanWithDiff } from '../occ/booleans'
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
            shape: table.register(box, 'ex_t'),
            sketch_id: 'sk_t',
            brep_diff: null,
            profile_queries: [],
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

  describe('hole inline cases', () => {
    it('reverse direction drills from opposite side', () => {
      // Hole with direction='reverse' drills from opposite side of the target.
      // The box sits BELOW the sketch plane (z = -10..0), so only a reverse
      // hole (drilling down from the plane) cuts it. The old fixture put the
      // box ABOVE the plane, where the reverse cylinder was flush with the
      // box's bottom face: OCC cut no material and the test's volume drop was
      // float noise, which the per-site probe now correctly reports instead.
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const repo = new Repository()
        repo.register('_pt_sk', { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] })
        repo.register('sk/p1/xy', { external_xy: [10, 10] })
        const box = makeBoxAt(occ, scope, [0, 0, -10], 20, 20, 10)
        const bodyStore: Record<string, Body> = {
          body_t: {
            id: 'body_t', created_by: 'ex_t', modified_by: [],
            shape: table.register(box, 'ex_t'),
            sketch_id: 'sk_t', brep_diff: null,
            profile_queries: [],
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
            shape: table.register(box, 'ex_first'),
            sketch_id: 'sk_first', brep_diff: null,
            profile_queries: [],
          },
        }
        // No `target` field, should default to body_first.
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

    // ─── Viewport picks in the sketch field ───

    // A 20x20x10 box to drill, registered as `body_t`.
    function boxTarget(occ: OccModule, scope: DisposeScope, table: HandleTable): Record<string, Body> {
      const box = makeBox(occ, scope, 20, 20, 10)
      return {
        body_t: {
          id: 'body_t', created_by: 'ex_t', modified_by: [],
          shape: table.register(box, 'ex_t'),
          sketch_id: 'sk_t', brep_diff: null,
          profile_queries: [],
        },
      }
    }

    it('a picked circle drills its OWN diameter, not the field\'s', () => {
      // The circle names both the position and the size of the hole the user
      // drew, and the size wins: the same pick through an extrude cut removes
      // exactly that cylinder, and a hole that came out at the field's 10 would
      // disagree with the r=3 circle still sitting in the sketch.
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const repo = new Repository()
        repo.register('_pt_sk', { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] })
        repo.register('sk/ci', { external_params: [10, 10, 3], kind: 'circle', sketch_id: 'sk' })
        repo.register('sk/p1/xy', { external_xy: [3, 3] })
        const bodyStore = boxTarget(occ, scope, table)
        const result = solveHole(occ, scope, table, {
          id: 'hole1',
          hole: { sketch: 'entity:sk:ci', diameter: 10, depth: 5, target: 'body_t' },
        }, repo, bodyStore, { sk: { entities: [{ id: 'ci', kind: 'circle' }, { id: 'p1', kind: 'point' }] } })
        expect(result.status).toBe('ok')
        // One hole: the point beside the circle is not part of this pick.
        expect(result.hole_count).toBe(1)
        const volume = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_t.shape!))
        expect(volume).toBeCloseTo(20 * 20 * 10 - Math.PI * 3 * 3 * 5, 2)
      } finally {
        scope.dispose()
      }
    })

    it('a picked point drills that point alone', () => {
      // Drilling every point in the sketch because the user clicked one of them
      // is a silent extra hole; the vertex form names the same entity.
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const repo = new Repository()
        repo.register('_pt_sk', { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] })
        repo.register('sk/p1/xy', { external_xy: [5, 5] })
        repo.register('sk/p2/xy', { external_xy: [15, 15] })
        const bodyStore = boxTarget(occ, scope, table)
        const result = solveHole(occ, scope, table, {
          id: 'hole1',
          hole: { sketch: 'vertex:sk:p1:xy', diameter: 4, depth: 5, target: 'body_t' },
        }, repo, bodyStore, { sk: { entities: [{ id: 'p1', kind: 'point' }, { id: 'p2', kind: 'point' }] } })
        expect(result.status).toBe('ok')
        expect(result.hole_count).toBe(1)
        const volume = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_t.shape!))
        expect(volume).toBeCloseTo(20 * 20 * 10 - Math.PI * 2 * 2 * 5, 2)
      } finally {
        scope.dispose()
      }
    })

    it('radial through-all hole fully pierces a cylinder', () => {
      // A cylinder's B-rep vertices sit only on its seam, so a vertex-only AABB
      // collapses radially: the span reads the height instead of the diameter
      // and a radial through-all cutter under-penetrates, stopping short of
      // the far wall while reporting ok. Sizing off the edge-sampled frame must
      // drive the cut clean through; the result volume must match an
      // independently built guaranteed-through cutter, and the body must stay
      // in one piece.
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const repo = new Repository()
        repo.register('_pt_sk', { origin: [-15, 0, 10], x_axis: [0, 1, 0], y_axis: [0, 0, 1], normal: [-1, 0, 0] })
        repo.register('sk/p1/xy', { external_xy: [0, 0] })
        const cyl = makeCylinder(occ, scope, [0, 0, 0], [0, 0, 1], 15, 20)
        const bodyStore: Record<string, Body> = {
          body_t: {
            id: 'body_t', created_by: 'ex_t', modified_by: [],
            shape: table.register(cyl, 'ex_t'),
            sketch_id: 'sk_t', brep_diff: null,
            profile_queries: [],
          },
        }
        const result = solveHole(occ, scope, table, {
          id: 'hole1',
          hole: { sketch: '@sk', diameter: 6, depth_mode: 'through_all', direction: 'normal', target: 'body_t' },
        }, repo, bodyStore, { sk: { entities: [{ id: 'p1', kind: 'point' }] } })
        expect(result.status).toBe('ok')
        expect(result.body_ids).toHaveLength(1)

        const refBody = makeCylinder(occ, scope, [0, 0, 0], [0, 0, 1], 15, 20)
        const refCutter = makeCylinder(occ, scope, [45, 0, 10], [-1, 0, 0], 3, 90)
        const refCut = booleanWithDiff(occ, scope, refBody, refCutter, 'cut')
        expect(volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_t.shape!))).toBeCloseTo(
          volumeOf(occ, scope, refCut.shape),
          3,
        )
      } finally {
        scope.dispose()
      }
    })

    it('through-all on an oblique datum plane fully pierces the body', () => {
      // bodySpan used to size the cutter from the max world-axis half-extent,
      // but a diagonal drill axis crosses a cube along its space diagonal: the
      // extent along an oblique unit axis is sum(|axis_i| * size_i), up to
      // sqrt(3) times the max-axis span. With the plane at one corner and the
      // body on the far side, the old [-span, +2span] cutter stopped 0.73*span
      // short of the far corner while intersects() was true, so the hole
      // reported ok with most of the body uncut. The projected span must drive
      // the cut fully through; the volume must match an independently built
      // guaranteed-through cutter.
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const s3 = Math.sqrt(3)
        const normal = [-1 / s3, -1 / s3, -1 / s3]
        // A basis in the plane through the origin corner. x_axis and y_axis are
        // orthonormal to the reversed body diagonal (normal).
        const xAxis = [1 / Math.SQRT2, -1 / Math.SQRT2, 0]
        const yAxis = [-1 / Math.sqrt(6), -1 / Math.sqrt(6), 2 / Math.sqrt(6)]
        const repo = new Repository()
        repo.register('_pt_sk', { origin: [0, 0, 0], x_axis: xAxis, y_axis: yAxis, normal })
        repo.register('sk/p1/xy', { external_xy: [0, 0] })
        const box = makeBox(occ, scope, 10, 10, 10)
        const bodyStore: Record<string, Body> = {
          body_t: {
            id: 'body_t', created_by: 'ex_t', modified_by: [],
            shape: table.register(box, 'ex_t'),
            sketch_id: 'sk_t', brep_diff: null,
            profile_queries: [],
          },
        }
        const result = solveHole(occ, scope, table, {
          id: 'hole1',
          hole: { sketch: '@sk', diameter: 6, depth_mode: 'through_all', direction: 'normal', target: 'body_t' },
        }, repo, bodyStore, { sk: { entities: [{ id: 'p1', kind: 'point' }] } })
        expect(result.status).toBe('ok')
        expect(result.body_ids).toHaveLength(1)

        const refBody = makeBox(occ, scope, 10, 10, 10)
        // Centre the reference cutter well before the corner along the axis so
        // it spans both directions through the body diagonal.
        const refCenter: Vec3 = [normal[0] * -100, normal[1] * -100, normal[2] * -100]
        const refCutter = makeCylinder(occ, scope, refCenter, normal as Vec3, 3, 200)
        const refCut = booleanWithDiff(occ, scope, refBody, refCutter, 'cut')
        expect(volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_t.shape!))).toBeCloseTo(
          volumeOf(occ, scope, refCut.shape),
          3,
        )
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
            shape: table.register(box, 'ex_t'),
            sketch_id: 'sk_t', brep_diff: null,
            profile_queries: [],
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

  describe('hole: a drill that removes nothing, or everything, says so', () => {
    function boxTarget(occ: OccModule, scope: DisposeScope, table: HandleTable): Record<string, Body> {
      const box = makeBox(occ, scope, 20, 20, 10)
      return {
        body_t: {
          id: 'body_t', created_by: 'ex_t', modified_by: [],
          shape: table.register(box, 'ex_t'),
          sketch_id: 'sk_t', brep_diff: null,
          profile_queries: [],
        },
      }
    }
    const PLANE = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }

    it('a hole placed entirely off the body warns that nothing was removed', () => {
      // M31: a drill site that had geometry but cut nothing used to report ok
      // with hole_count: 1 and an unchanged body. The site-only emptiness probe
      // must surface it as a warning, and hole_count drops to 0.
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const repo = new Repository()
        repo.register('_pt_sk', PLANE)
        repo.register('sk/p1/xy', { external_xy: [100, 100] })
        const bodyStore = boxTarget(occ, scope, table)
        const boxVol = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_t.shape!))

        const result = solveHole(occ, scope, table, {
          id: 'hole1',
          hole: { sketch: '@sk', diameter: 4, depth: 5, target: 'body_t' },
        }, repo, bodyStore, { sk: { entities: [{ id: 'p1', kind: 'point' }] } })

        expect(result.status).toBe('ok')
        expect(result.hole_count).toBe(0)
        expect(result.solver_warning).toMatch(/none of the 1 drill site\(s\) intersect body 'body_t'; nothing was removed/)
        expect(result.body_ids).toEqual(['body_t'])
        expect(volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_t.shape!))).toBeCloseTo(boxVol, 6)
      } finally {
        scope.dispose()
      }
    })

    it('a through-hole wider than the body deletes the body and names the deletion', () => {
      // A cutter that encloses the whole body in the plane returns an empty
      // result; resplitBody's deletion path must remove the body from the store
      // and the leaf must report body_ids: [] instead of a live id.
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const repo = new Repository()
        repo.register('_pt_sk', PLANE)
        repo.register('sk/p1/xy', { external_xy: [10, 10] })
        const bodyStore = boxTarget(occ, scope, table)

        const result = solveHole(occ, scope, table, {
          id: 'hole1',
          hole: { sketch: '@sk', diameter: 30, depth_mode: 'through_all', target: 'body_t' },
        }, repo, bodyStore, { sk: { entities: [{ id: 'p1', kind: 'point' }] } })

        expect(result.status).toBe('ok')
        expect(result.body_ids).toEqual([])
        expect(result.body_id).toBe('body_t')  // still names the consumed body
        expect(result.solver_warning).toMatch(/the cut removed all of body 'body_t'; the body was deleted/)
        expect('body_t' in bodyStore).toBe(false)
      } finally {
        scope.dispose()
      }
    })

    it('a mixed fixture reports partial and names the site that missed', () => {
      // One site cuts, one removes nothing: partial, with the miss named so the
      // user knows which pick to move. hole_count counts sites that cut.
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const repo = new Repository()
        repo.register('_pt_sk', PLANE)
        repo.register('sk/p1/xy', { external_xy: [5, 5] })
        repo.register('sk/p2/xy', { external_xy: [100, 100] })
        const bodyStore = boxTarget(occ, scope, table)

        const result = solveHole(occ, scope, table, {
          id: 'hole1',
          hole: { sketch: '@sk', diameter: 4, depth: 5, target: 'body_t' },
        }, repo, bodyStore, { sk: { entities: [{ id: 'p1', kind: 'point' }, { id: 'p2', kind: 'point' }] } })

        expect(result.status).toBe('partial')
        expect(result.hole_count).toBe(1)
        expect(result.exception).toMatch(/1\/2 drill site\(s\) did not intersect body 'body_t': p2/)
        expect(result.solver_warning).toBeUndefined()
        expect(volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_t.shape!))).toBeLessThan(20 * 20 * 10)
      } finally {
        scope.dispose()
      }
    })
  })
})
