// @vitest-environment node
//
// Regression guard for review-17 M1: untracked intermediate TopoDS shapes on
// the lowering path lived for the whole worker session and accumulated once
// per edit of a dirty feature. The fix tracks every intermediate at creation
// (bounded lifetime even on throw) and releases it mid-build once consumed.
// These tests re-solve the same feature repeatedly against real OCC and
// require the per-build disposal traffic to be positive AND flat: before the
// fix these counters never moved (the shapes bypassed the scope entirely);
// after it they must sit at the same value every rebuild, with identical
// geometry per build proving the early frees changed nothing visible.
//
// Skips when OCC.js is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope, type Disposable } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import { makeBox } from '../occ/primitives'
import { volumeOf } from '../occ/booleans'
import { solidToEdges } from '../occ/tessellation'
import { extrudeProfileWithLineage } from '../occ/prismLineage'
import { solveExtrude } from './extrude'
import { solveRevolve } from './revolve'
import { solveArray } from './array'
import type { Repository } from '../query'
import type { Body } from '../types3d'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { LoopEdge } from '../profileLoops'

const oc = await loadOcc()

// Counting seam: the intermediates under test are exactly the objects that
// now flow through track()+release() instead of bypassing the scope.
class CountingScope extends DisposeScope {
  trackedCount = 0
  releasedCount = 0
  override track<T extends Disposable>(obj: T): T {
    this.trackedCount++
    return super.track(obj)
  }
  override release<T extends Disposable>(obj: T): T {
    this.releasedCount++
    return super.release(obj)
  }
}

const PLANE = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
// Leaves read _topo_/_pt_ entries off repo.elements during profile collection.
const nullRepo = { query: () => null, elements: new Map() } as unknown as Repository

function rectLoops(w: number, h: number): LoopEdge[][] {
  return [[
    { kind: 'line', start: [0, 0], end: [w, 0] },
    { kind: 'line', start: [w, 0], end: [w, h] },
    { kind: 'line', start: [w, h], end: [0, h] },
    { kind: 'line', start: [0, h], end: [0, 0] },
  ]] as unknown as LoopEdge[][]
}

describe.skipIf(!oc)('lowering-path intermediates do not accumulate (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  // Run `build` R times on fresh scopes; collect counters plus build values.
  function repeated<R>(
    runs: number,
    build: (scope: CountingScope, i: number) => R,
  ): { tracked: number[]; released: number[]; values: R[] } {
    const tracked: number[] = []
    const released: number[] = []
    const values: R[] = []
    for (let i = 0; i < runs; i++) {
      const scope = new CountingScope()
      try {
        values.push(build(scope, i))
      } finally {
        scope.dispose()
      }
      tracked.push(scope.trackedCount)
      released.push(scope.releasedCount)
    }
    return { tracked, released, values }
  }

  function expectFlat(counts: number[]): void {
    expect(counts[0]).toBeGreaterThan(0)  // intermediates route through the scope at all
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBe(counts[0])  // no rebuild retains more than another
    }
  }

  it('extrudeProfileWithLineage keeps per-build disposal flat across depth edits', () => {
    const runs = repeated(5, (scope, i) => {
      const d = 10 + i  // dirty-feature edit: the depth changes every rebuild
      const r = extrudeProfileWithLineage(
        occ,
        scope,
        rectLoops(20, 10),
        PLANE,
        [0, 0, 1],
        d,
        'sk1',
        'ex1',
      )
      scope.track(r.solid)
      return volumeOf(occ, scope, r.solid)
    })
    runs.values.forEach((vol, i) => expect(vol).toBeCloseTo(200 * (10 + i), 6))
    expectFlat(runs.released)
    expectFlat(runs.tracked)
  })

  // Leaf scenarios use a picked-edge profile off a box body (upToReal harness).
  // The box body stays registered for the whole scenario: the edge queries
  // resolve against it, exactly as upToReal keeps body_b in its store.
  function leafFixture(): {
    table: HandleTable
    loop: string[]
    bodyStore: Record<string, Body>
  } {
    const table = new HandleTable({ finalizerGuard: false })
    const scope = new DisposeScope()
    try {
      const box = makeBox(occ, scope, 10, 10, 10)
      const bodyB: Body = {
        id: 'body_b', created_by: 'seed', modified_by: [],
        shape: table.register(box, 'seed'), sketch_id: 'sk',
        brep_diff: null, profile_queries: [],
      }
      const { edges, edge_queries } = solidToEdges(occ, table, bodyB.shape!, {
        createdBy: bodyB.created_by, bodyId: bodyB.id,
        profileQueries: [],
        edgeAncestry: null, edgeNames: null,
      })
      const loop: string[] = []
      for (let i = 0; i < edges.length; i++) {
        const ed = edges[i]
        if (ed.kind === 'line' && Math.abs(ed.start[2]) < 1e-6 && Math.abs(ed.end[2]) < 1e-6) {
          loop.push(edge_queries[i])
        }
      }
      return { table, loop, bodyStore: { body_b: bodyB } }
    } finally {
      scope.dispose()
    }
  }

  // Re-solve one leaf feature R times; each run is one dirty-feature edit.
  function repeatedLeaf(
    runs: number,
    solve: (
      scope: CountingScope,
      fx: { table: HandleTable; loop: string[]; bodyStore: Record<string, Body> },
    ) => number,
  ): { released: number[]; volumes: number[] } {
    const fx = leafFixture()
    try {
      const released: number[] = []
      const volumes: number[] = []
      for (let i = 0; i < runs; i++) {
        // Drop only the feature's own body from the previous edit.
        fx.table.releaseOwner('ex9')
        delete fx.bodyStore.body_ex9
        const scope = new CountingScope()
        try {
          volumes.push(solve(scope, fx))
        } finally {
          scope.dispose()
        }
        released.push(scope.releasedCount)
      }
      return { released, volumes }
    } finally {
      fx.table.disposeAll()
    }
  }

  it('symmetric face-profile extrude (fuse chain) keeps per-build disposal flat', () => {
    const { released, volumes } = repeatedLeaf(4, (scope, fx) => {
      const result = solveExtrude(
        occ, scope, fx.table,
        { id: 'ex9', extrude: { sketch: fx.loop, distance: 8, direction: 'symmetric', operation: 'new' } },
        nullRepo, fx.bodyStore,
      )
      expect(result.status).toBe('ok')
      return volumeOf(occ, scope, fx.table.get<OccShape>(fx.bodyStore.body_ex9!.shape!))
    })
    volumes.forEach((v) => expect(v).toBeCloseTo(volumes[0], 6))
    volumes.forEach((v) => expect(v).toBeGreaterThan(0))
    expectFlat(released)
  })

  it('up_to extrude (trim half-space) keeps per-build disposal flat', () => {
    const { released, volumes } = repeatedLeaf(4, (scope, fx) => {
      // Cut plane 7 ahead of the z=0 profile along +z.
      const repo = { query: () => ({ type: 'flatface', origin: [5, 5, 7], normal: [0, 0, 1] }) } as unknown as Repository
      const result = solveExtrude(
        occ, scope, fx.table,
        { id: 'ex9', extrude: { sketch: fx.loop, distance: 999, termination: 'up_to', up_to: 'plane_q', operation: 'new' } },
        repo, fx.bodyStore,
      )
      expect(result.status).toBe('ok')
      return volumeOf(occ, scope, fx.table.get<OccShape>(fx.bodyStore.body_ex9!.shape!))
    })
    volumes.forEach((v) => expect(v).toBeCloseTo(700, 2))
    expectFlat(released)
  })

  it('symmetric face-profile revolve keeps per-build disposal flat', () => {
    const { released, volumes } = repeatedLeaf(4, (scope, fx) => {
      const result = solveRevolve(
        occ, scope, fx.table,
        // A body-face slash ref resolves straight to an OCC profile face, so
        // this drives the cqFaces fuse chain (revolveFace + fuses). Face 0 of
        // the box revolves cleanly around the world z axis; face 2 is
        // degenerate for that axis. The axis is spelled out because the leaf
        // rejects an axis-less revolve rather than defaulting to z.
        { id: 'ex9', revolve: {
          sketch: '@body_b/face/0', angle: 120, direction: 'symmetric', operation: 'new',
          axis_origin: [0, 0, 0], axis_direction: [0, 0, 1],
        } },
        nullRepo, fx.bodyStore,
      )
      expect(result.status).toBe('ok')
      return volumeOf(occ, scope, fx.table.get<OccShape>(fx.bodyStore.body_ex9!.shape!))
    })
    volumes.forEach((v) => expect(v).toBeCloseTo(volumes[0], 6))
    volumes.forEach((v) => expect(v).toBeGreaterThan(0))
    expectFlat(released)
  })

  // H21: the array add fuse loop releases the superseded fused solid and the
  // consumed instance at the end of every iteration (array.ts:250-274). The
  // loop is the ONLY release traffic on this path (booleans/transformLineage/
  // bodySplit never call scope.release), so releasedCount is exactly 2 per
  // extra instance minus one: iteration 1 skips the table-owned source and
  // contributes a single release, every later iteration two.
  function arrayRun(countX: number): { released: number } {
    const table = new HandleTable({ finalizerGuard: false })
    const scope = new CountingScope()
    try {
      const box = makeBox(occ, scope, 10, 10, 10)
      const bodyB: Body = {
        id: 'body_b', created_by: 'seed', modified_by: [],
        shape: table.register(box, 'seed'), sketch_id: 'sk',
        brep_diff: null, profile_queries: [],
      }
      const bodyStore: Record<string, Body> = { body_b: bodyB }
      // The direction query resolves to a straight edge along +X so the leaf
      // does not refuse the array.
      const repo = { query: () => ({ start: [0, 0, 0], end: [1, 0, 0] }), elements: new Map() } as unknown as Repository
      const result = solveArray(
        occ, scope, table,
        { id: 'ar9', array: {
          source_body: 'body_b', mode: 'linear', count_x: countX, pitch_x: 20,
          include_source: true, operation: 'add', direction_x_query: 'qx',
        } },
        repo, bodyStore,
      )
      expect(result.status).toBe('ok')
      return { released: scope.releasedCount }
    } finally {
      scope.dispose()
      table.disposeAll()
    }
  }

  it('array add releases exactly two objects per extra instance, flat across rebuilds', () => {
    // Fresh identical geometry per run, so any flatness violation is release
    // traffic that scales with something other than the instance count.
    const c4: number[] = []
    for (let i = 0; i < 3; i++) c4.push(arrayRun(4).released)
    expectFlat(c4)
    const c12: number[] = []
    for (let i = 0; i < 3; i++) c12.push(arrayRun(12).released)
    expectFlat(c12)
    // Eight extra instances (4 -> 12) each add two releases: the superseded
    // fused and the consumed instance. Pre-fix the loop released nothing.
    expect(c12[0] - c4[0]).toBe(16)
    // Six full array solves (three at count 4, three at count 12) can run long
    // under the suite's parallel load; the default 5s timeout has flaked this
    // case, so it gets its own generous budget.
  }, 20_000)
})
