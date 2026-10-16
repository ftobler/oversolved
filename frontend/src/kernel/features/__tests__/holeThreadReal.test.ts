// @vitest-environment node
//
// The cosmetic thread on a hole, against the real kernel: the thread changes no
// geometry (same volume, same faces as the same hole without one) and the solve
// reports its metadata plus one display helix per drilled site, riding the bore
// wall. The thread table's own contract lives in kernel/__tests__/threadTable
// and the helix sampling in features/__tests__/threadDisplay.
//
// Skips when opencascade.js is absent, like every *Real suite.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { makeBox, faceCentroid } from '../../occ/primitives'
import { volumeOf } from '../../occ/volume'
import { canonicalFaces } from '../../occ/bodyNames'
import { Repository } from '../../query'
import { solveHole } from '../hole'
import type { Body } from '../../types3d'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { PlaneLike } from '../shared/planes'

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

  it('reports the thread metadata and one helix on the bore wall per site', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const { result } = drill(scope, table, {
        diameter: 5, depth_mode: 'blind', depth: 6,
        thread: { designation: 'M6x1', nominal: 6, pitch: 1 },
      })
      const thread = result.thread as {
        designation: string; nominal: number; pitch: number
        helices: { radius: number; pitch: number; turns: number; center: number[]; axis: number[]; points: number[][] }[]
      }
      expect(thread).toBeDefined()
      expect(thread.designation).toBe('M6x1')
      expect(thread.nominal).toBe(6)
      expect(thread.pitch).toBe(1)
      expect(thread.helices).toHaveLength(1)
      const [helix] = thread.helices
      // The bore wall: the drilled radius, not the thread's nominal.
      expect(helix.radius).toBe(2.5)
      expect(helix.turns).toBe(6)
      // The drilled axis points down (the hole was cut from the top downward).
      expect(helix.axis.map((n) => n + 0)).toEqual([0, 0, -1])
      for (const p of helix.points) {
        expect(Math.hypot(p[0] - helix.center[0], p[1] - helix.center[1])).toBeCloseTo(2.5, 6)
      }
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
      const thread = result.thread as { helices: { turns: number }[] }
      // The body is 10 deep along the axis, so a 1 mm pitch gives 10 turns.
      expect(thread.helices[0].turns).toBeCloseTo(10, 6)
    } finally {
      scope.dispose()
    }
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

  it('draws no helix for a site that misses the body', () => {
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
      // thread must not draw there.
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
