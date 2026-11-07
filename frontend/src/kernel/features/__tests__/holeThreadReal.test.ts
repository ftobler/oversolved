// @vitest-environment node
//
// The cosmetic thread on a hole, against the real kernel: the thread changes no
// geometry (same volume, same faces as the same hole without one) and the solve
// reports its metadata plus one tapped run per drilled site, named by the bore
// face's uuid and cut short by `thread_depth`. The thread table's own contract
// lives in kernel/__tests__/threadTable and the shading in
// components/Geometry3D/__tests__/threadShading.
//
// Skips when opencascade.js is absent, like every *Real suite.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { makeBox, makeBoxAt, faceCentroid, faceSurfaceType } from '../../occ/primitives'
import { booleanWithDiff } from '../../occ/booleans'
import { volumeOf } from '../../occ/volume'
import { canonicalFaces } from '../../occ/bodyNames'
import { Repository } from '../../query'
import { solveHole } from '../hole'
import type { Body } from '../../types3d'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { PlaneLike } from '../shared/planes'
import type { ThreadDisplayData } from '@/types/cad'

const oc = await loadOcc()

const PLANE: PlaneLike = { origin: [0, 0, 10], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }

interface HoleCase {
  bodies: Record<string, Body>
  result: Record<string, unknown>
}

describe.skipIf(!oc)('the cosmetic thread on a hole (real OCC)', () => {
  let occ: OccModule
  if (oc) occ = oc

  /** A named 10-cube with a drill site registered at the sketch origin, cut
   *  from the top face downward through the plate. */
  function drill(scope: DisposeScope, table: HandleTable, hole: Record<string, unknown>): HoleCase {
    const box = makeBox(occ, scope, 10, 10, 10)
    const body: Body = {
      id: 'body_b', created_by: 'ex1', modified_by: [], shape: table.register(box, 'ex1'),
      sketch_id: 'sk', brep_diff: null, profile_queries: [],
      face_uuids: (canonicalFaces(occ, scope, box) as OccShape[]).map((_, i) => `f${i}`),
    }
    const bodies: Record<string, Body> = { body_b: body }
    const repo = new Repository()
    repo.register('_pt_sk_h', PLANE)
    // A site at the plate's middle, so a blind bore sits wholly inside it.
    repo.register('sk_h/p1/xy', { external_xy: [5, 5] })
    const result = solveHole(occ, scope, table, {
      id: 'h1',
      hole: { sketch: '@sk_h', direction: 'reverse', target: 'body_b', ...hole },
    }, repo, bodies, { sk_h: { entities: [{ id: 'p1', kind: 'point' }] } })
    return { bodies, result }
  }

  it('drills the same geometry with and without a thread', () => {
    const plain = new DisposeScope()
    const threaded = new DisposeScope()
    const t1 = new HandleTable()
    const t2 = new HandleTable()
    try {
      const a = drill(plain, t1, { diameter: 5, depth_mode: 'blind', depth: 6 })
      const b = drill(threaded, t2, {
        diameter: 5, depth_mode: 'blind', depth: 6,
        thread: { designation: 'M6x1', nominal: 6, pitch: 1 },
      })
      expect(a.result.status).toBe('ok')
      expect(b.result.status).toBe('ok')
      const va = volumeOf(occ, plain, t1.get<OccShape>(a.bodies.body_b.shape!))
      const vb = volumeOf(occ, threaded, t2.get<OccShape>(b.bodies.body_b.shape!))
      expect(vb).toBeCloseTo(va, 9)
      expect(va).toBeCloseTo(1000 - Math.PI * 2.5 * 2.5 * 6, 6)
      // A thread is metadata: no extra face, no extra body.
      expect(canonicalFaces(occ, threaded, t2.get<OccShape>(b.bodies.body_b.shape!))).toHaveLength(
        canonicalFaces(occ, plain, t1.get<OccShape>(a.bodies.body_b.shape!)).length,
      )
      expect(b.result.hole_count).toBe(1)
    } finally {
      plain.dispose()
      threaded.dispose()
    }
  })

  it('reports the thread metadata and one tapped run on the bore per site', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const { bodies, result } = drill(scope, table, {
        diameter: 5, depth_mode: 'blind', depth: 6,
        thread: { designation: 'M6x1', nominal: 6, pitch: 1 },
      })
      const thread = result.thread as ThreadDisplayData
      expect(thread).toBeDefined()
      expect(thread.designation).toBe('M6x1')
      expect(thread.nominal).toBe(6)
      expect(thread.pitch).toBe(1)
      expect(thread.sites).toHaveLength(1)
      const [site] = thread.sites
      // The bore wall: the drilled radius, not the thread's nominal.
      expect(site.radius).toBe(2.5)
      // No thread_depth: the whole bore is tapped.
      expect(site.length).toBeCloseTo(6, 9)
      // The drilled axis points down (the hole was cut from the top downward),
      // and the tapped run starts at the entry face.
      expect(site.axis.map((n) => n + 0)).toEqual([0, 0, -1])
      expect(site.center[2]).toBeCloseTo(10, 9)
      // The viewport finds the bore by the uuid the hole minted for it, so the
      // reported uuid must be one the drilled body actually carries.
      expect(site.bore_uuids).toHaveLength(1)
      expect(bodies.body_b.face_uuids).toContain(site.bore_uuids[0])
    } finally {
      scope.dispose()
    }
  })

  it('runs the thread through the body span for a through hole', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const { result } = drill(scope, table, {
        diameter: 5, depth_mode: 'through_all', depth: 6,
        thread: { designation: 'M6x1', nominal: 6, pitch: 1 },
      })
      const thread = result.thread as ThreadDisplayData
      // The body is 10 deep along the axis.
      expect(thread.sites[0].length).toBeCloseTo(10, 6)
    } finally {
      scope.dispose()
    }
  })

  describe('bore_uuids: the faces the viewport shades', () => {
    const M6 = { designation: 'M6x1', nominal: 6, pitch: 1 }

    // Every cylinder face of the drilled body whose uuid the thread names.
    function namedBoreFaces(scope: DisposeScope, table: HandleTable, c: HoleCase): number {
      const shape = table.get<OccShape>(c.bodies.body_b.shape!)
      const uuids = c.bodies.body_b.face_uuids ?? []
      const named = new Set((c.result.thread as ThreadDisplayData).sites.flatMap(s => s.bore_uuids))
      return (canonicalFaces(occ, scope, shape) as OccShape[])
        .filter((face, i) => faceSurfaceType(occ, scope, face) === 'cylinderface' && named.has(uuids[i] ?? ''))
        .length
    }

    for (const [label, hole] of [
      ['counterbore', { depth_mode: 'blind', depth: 8, style: 'counterbore', cb_diameter: 8, cb_depth: 2 }],
      ['countersink', { depth_mode: 'blind', depth: 8, style: 'countersink', cb_diameter: 8 }],
      ['drill point', { depth_mode: 'blind', depth: 6, tip: 'drill_point' }],
      ['through hole', { depth_mode: 'through_all' }],
    ] as const) {
      it(`names the bore, and only the bore, of a ${label}`, () => {
        const scope = new DisposeScope()
        const table = new HandleTable()
        try {
          const c = drill(scope, table, { diameter: 5, thread: M6, ...hole })
          const [site] = (c.result.thread as ThreadDisplayData).sites
          expect(site.bore_uuids.length).toBeGreaterThan(0)
          for (const uuid of site.bore_uuids) expect(c.bodies.body_b.face_uuids).toContain(uuid)
          // The counterbore wall is a cylinder too; it must not be named.
          expect(namedBoreFaces(scope, table, c)).toBe(site.bore_uuids.length)
        } finally {
          scope.dispose()
        }
      })
    }

    it('names every piece of a through bore that crosses a slot', () => {
      const scope = new DisposeScope()
      const table = new HandleTable()
      try {
        // A 10-cube with a slot through its middle layer (z 4..6, x 2..8, all
        // of y): a through bore at (5, 5) crosses the gap and leaves two walls,
        // which the boolean names as split children of the bore.
        const box = makeBox(occ, scope, 10, 10, 10)
        const slot = makeBoxAt(occ, scope, [2, -1, 4], 6, 12, 2)
        const slotted = scope.track(booleanWithDiff(occ, scope, box, slot, 'cut').shape)
        const body: Body = {
          id: 'body_b', created_by: 'ex1', modified_by: [], shape: table.register(slotted, 'ex1'),
          sketch_id: 'sk', brep_diff: null, profile_queries: [],
          face_uuids: (canonicalFaces(occ, scope, slotted) as OccShape[]).map((_, i) => `f${i}`),
        }
        const bodies: Record<string, Body> = { body_b: body }
        const repo = new Repository()
        repo.register('_pt_sk_h', PLANE)
        repo.register('sk_h/p1/xy', { external_xy: [5, 5] })
        const result = solveHole(occ, scope, table, {
          id: 'h1',
          hole: { sketch: '@sk_h', direction: 'reverse', target: 'body_b', diameter: 3, depth_mode: 'through_all', thread: M6 },
        }, repo, bodies, { sk_h: { entities: [{ id: 'p1', kind: 'point' }] } })
        const [site] = (result.thread as ThreadDisplayData).sites
        expect(site.bore_uuids).toHaveLength(2)
        for (const uuid of site.bore_uuids) expect(bodies.body_b.face_uuids).toContain(uuid)
        expect(namedBoreFaces(scope, table, { bodies, result })).toBe(2)
      } finally {
        scope.dispose()
      }
    })
  })

  describe('thread_depth: a tapped run shorter than the drill', () => {
    const M6 = { designation: 'M6x1', nominal: 6, pitch: 1 }

    it('taps the first thread_depth of a deeper blind bore, geometry unchanged', () => {
      const plain = new DisposeScope()
      const tapped = new DisposeScope()
      const t1 = new HandleTable()
      const t2 = new HandleTable()
      try {
        const a = drill(plain, t1, { diameter: 5, depth_mode: 'blind', depth: 8, thread: M6 })
        const b = drill(tapped, t2, { diameter: 5, depth_mode: 'blind', depth: 8, thread: M6, thread_depth: 5 })
        expect(b.result.status).toBe('ok')
        expect(b.result.solver_warning).toBeUndefined()
        const site = (b.result.thread as ThreadDisplayData).sites[0]
        expect(site.length).toBeCloseTo(5, 9)
        expect(site.center[2]).toBeCloseTo(10, 9)
        expect(volumeOf(occ, tapped, t2.get<OccShape>(b.bodies.body_b.shape!)))
          .toBeCloseTo(volumeOf(occ, plain, t1.get<OccShape>(a.bodies.body_b.shape!)), 9)
      } finally {
        plain.dispose()
        tapped.dispose()
      }
    })

    it('starts below a counterbore and stops at thread_depth from the entry', () => {
      const scope = new DisposeScope()
      const table = new HandleTable()
      try {
        const { result } = drill(scope, table, {
          diameter: 5, depth_mode: 'blind', depth: 8, style: 'counterbore', cb_diameter: 8, cb_depth: 2,
          thread: M6, thread_depth: 6,
        })
        const site = (result.thread as ThreadDisplayData).sites[0]
        expect(site.center[2]).toBeCloseTo(8, 9)
        expect(site.length).toBeCloseTo(4, 9)
      } finally {
        scope.dispose()
      }
    })

    it('clamps a thread_depth past the bore end with a warning, still ok', () => {
      const scope = new DisposeScope()
      const table = new HandleTable()
      try {
        const { result } = drill(scope, table, {
          diameter: 5, depth_mode: 'blind', depth: 6, thread: M6, thread_depth: 9,
        })
        expect(result.status).toBe('ok')
        expect((result.thread as ThreadDisplayData).sites[0].length).toBeCloseTo(6, 9)
        expect(result.solver_warning).toMatch(
          /thread_depth 9 exceeds the bore at sites p1 \(6\) \(bore length in parentheses\); the thread stops at the bore end/,
        )
      } finally {
        scope.dispose()
      }
    })

    it('never taps into a drill-point cone', () => {
      const scope = new DisposeScope()
      const table = new HandleTable()
      try {
        const { result } = drill(scope, table, {
          diameter: 5, depth_mode: 'blind', depth: 6, tip: 'drill_point', thread: M6, thread_depth: 7,
        })
        expect((result.thread as ThreadDisplayData).sites[0].length).toBeCloseTo(6, 9)
        expect(result.solver_warning).toMatch(/exceeds the bore/)
      } finally {
        scope.dispose()
      }
    })

    it('taps nothing when thread_depth ends inside the counterbore, cut intact', () => {
      const scope = new DisposeScope()
      const table = new HandleTable()
      try {
        const { result } = drill(scope, table, {
          diameter: 5, depth_mode: 'blind', depth: 8, style: 'counterbore', cb_diameter: 8, cb_depth: 3,
          thread: M6, thread_depth: 2,
        })
        expect(result.status).toBe('ok')
        expect(result.hole_count).toBe(1)
        expect((result.thread as ThreadDisplayData | undefined)?.sites ?? []).toEqual([])
        expect(result.solver_warning).toMatch(/thread_depth 2 ends above the bore \(inside the counterbore\) at sites p1/)
      } finally {
        scope.dispose()
      }
    })

    it('measures a through hole from the entry face', () => {
      const scope = new DisposeScope()
      const table = new HandleTable()
      try {
        const { result } = drill(scope, table, {
          diameter: 5, depth_mode: 'through_all', thread: M6, thread_depth: 4,
        })
        const site = (result.thread as ThreadDisplayData).sites[0]
        expect(site.length).toBeCloseTo(4, 6)
        expect(site.center[2]).toBeCloseTo(10, 6)
      } finally {
        scope.dispose()
      }
    })

    it('refuses a non-positive thread_depth, and ignores it without a thread', () => {
      const scope = new DisposeScope()
      const table = new HandleTable()
      try {
        expect(() => drill(scope, table, {
          diameter: 5, depth_mode: 'blind', depth: 6, thread: M6, thread_depth: 0,
        })).toThrow(/thread_depth must be positive/)
        // A value the thread checkbox left behind must not refuse a plain hole.
        const { result } = drill(scope, table, { diameter: 5, depth_mode: 'blind', depth: 6, thread_depth: 0 })
        expect(result.status).toBe('ok')
        expect(result.thread).toBeUndefined()
      } finally {
        scope.dispose()
      }
    })
  })

  it('reports no thread for a plain hole, and refuses a malformed spec', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const { result } = drill(scope, table, { diameter: 5, depth_mode: 'blind', depth: 6 })
      expect(result.thread).toBeUndefined()
      expect(() =>
        drill(scope, table, {
          diameter: 5, depth_mode: 'blind', depth: 6,
          thread: { designation: '', nominal: 6, pitch: 1 },
        }),
      ).toThrow(/needs a designation/)
      expect(() =>
        drill(scope, table, {
          diameter: 5, depth_mode: 'blind', depth: 6,
          thread: { designation: 'M6x1', nominal: 6, pitch: 0 },
        }),
      ).toThrow(/pitch must be positive/)
    } finally {
      scope.dispose()
    }
  })

  it('taps no site that misses the body', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const box = makeBox(occ, scope, 10, 10, 10)
      const body: Body = {
        id: 'body_b', created_by: 'ex1', modified_by: [], shape: table.register(box, 'ex1'),
        sketch_id: 'sk', brep_diff: null, profile_queries: [],
        face_uuids: (canonicalFaces(occ, scope, box) as OccShape[]).map((_, i) => `f${i}`),
      }
      const bodies: Record<string, Body> = { body_b: body }
      const repo = new Repository()
      // A drill site 50 mm off the body: the cutter removes nothing, so the
      // thread must not show there.
      repo.register('_pt_sk_h', { ...PLANE, origin: [50, 50, 10] })
      // A site at the plate's middle, so a blind bore sits wholly inside it.
    repo.register('sk_h/p1/xy', { external_xy: [5, 5] })
      const result = solveHole(occ, scope, table, {
        id: 'h1',
        hole: {
          sketch: '@sk_h', direction: 'reverse', target: 'body_b',
          diameter: 5, depth_mode: 'blind', depth: 6,
          thread: { designation: 'M6x1', nominal: 6, pitch: 1 },
        },
      }, repo, bodies, { sk_h: { entities: [{ id: 'p1', kind: 'point' }] } })
      expect(result.thread).toBeUndefined()
      expect(result.solver_warning).toMatch(/nothing was removed/)
    } finally {
      scope.dispose()
    }
  })

  it('keeps the top face where it was: the thread does not move the body', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const { bodies } = drill(scope, table, {
        diameter: 5, depth_mode: 'blind', depth: 6,
        thread: { designation: 'M6x1', nominal: 6, pitch: 1 },
      })
      const faces = canonicalFaces(occ, scope, table.get<OccShape>(bodies.body_b.shape!)) as OccShape[]
      const top = faces.reduce((best, f) =>
        faceCentroid(occ, scope, f)[2] > faceCentroid(occ, scope, best)[2] ? f : best)
      expect(faceCentroid(occ, scope, top)[2]).toBeCloseTo(10, 6)
    } finally {
      scope.dispose()
    }
  })
})
