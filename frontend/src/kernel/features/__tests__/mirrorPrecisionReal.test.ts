// @vitest-environment node
//
// Feature-level precision: the body record a sketch solve produces, and the
// merge that reads it. Companion to the kernel-level
// `occ/__tests__/mergeToleranceReal.test.ts`; here the whole builder runs.
//
// The half-cube cases are the solver plan's control table (10 x 20 on Front,
// mirrored on Right with merge). A 0-DOF sketch lands its walls exactly and the
// mirror folds them into 6 faces; a 1-DOF sketch whose free direction is a
// rotation keeps the authored 1e-6 rad tilt, so the halves meet across a
// 2e-5-wide wedge and the body keeps 10 faces. That is the rule the whole
// feature rests on: a free tilt no row measures stays split.
//
// The direct `solveMirror` cases then show the opposite side of the same rule:
// a *reported* miss widens the merge and folds a 5e-11 seam, and a report above
// the ceiling is clamped with a warning naming the sketch.

import { describe, it, expect } from 'vitest'
import type { BuildResponse } from '../../builder'
import type { Body, BuildState } from '../../types3d'
import type { OccModule, OccShape } from '../../occ/occTypes'
import { SharedHarness } from '../../occ/sharedHarness'
import { exploreFaces } from '../../occ/edgeModifier'
import { faceNormal } from '../../occ/primitives'
import { DisposeScope } from '../../occ/disposeScope'
import { initGlobalRepo } from '../../query'
import { oc, extrudeTestHarness } from '../extrudeRealSupport'
import { solveMirror } from '../transformMirror'
import { contractPrecision } from '../../precision'
import { OCC_ANGULAR, OCC_CONFUSION } from '../../solverConstants'

/** Rotate a sketch point about the origin: the seeds below are a half-cube. */
function rotate(x: number, y: number, theta: number): [number, number] {
  return [x * Math.cos(theta) - y * Math.sin(theta), x * Math.sin(theta) + y * Math.cos(theta)]
}

/**
 * A 10 x 20 half-cube on Front: x in [0, 10], y in [-10, 10], left edge centred
 * on the origin. The mirror plane is Right (x = 0), so the union is a 20-wide
 * box whose four long faces are split at x = 0 until the merge folds them.
 */
function halfCubeSketch(theta: number, constraints: Record<string, unknown>[]) {
  const a = rotate(0, -10, theta)
  const b = rotate(10, -10, theta)
  const c = rotate(10, 10, theta)
  const d = rotate(0, 10, theta)
  return {
    id: 'sk1', kind: 'sketch', label: 'Half cube', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
      { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
    ],
    initial: {
      bottom: [a[0], a[1], b[0], b[1]],
      right: [b[0], b[1], c[0], c[1]],
      top: [c[0], c[1], d[0], d[1]],
      left: [d[0], d[1], a[0], a[1]],
    },
    constraints,
  }
}

const corners = [
  { id: 'k1', kind: 'coincident', a: '$bottomend', b: '$rightstart' },
  { id: 'k2', kind: 'coincident', a: '$rightend', b: '$topstart' },
  { id: 'k3', kind: 'coincident', a: '$topend', b: '$leftstart' },
  { id: 'k4', kind: 'coincident', a: '$leftend', b: '$bottomstart' },
]
const normals = [
  { id: 'n1', kind: 'normal', a: '$bottom', b: '$right' },
  { id: 'n2', kind: 'normal', a: '$right', b: '$top' },
  { id: 'n3', kind: 'normal', a: '$top', b: '$left' },
  { id: 'n4', kind: 'normal', a: '$left', b: '$bottom' },
]
const sizes = [
  { id: 'l1', kind: 'length', target: '$bottom', value: 10 },
  { id: 'l2', kind: 'length', target: '$right', value: 20 },
]
const originPin = { id: 'm1', kind: 'midpoint', line: '$left', point: '@builtin_origin' }
const rotationPin = { id: 'd1', kind: 'point_distance_x', a: '$leftstart', b: '$leftend', value: 0 }

function halfCubeDoc(sketch: Record<string, unknown>, mirror = true) {
  return {
    features: [
      sketch,
      { id: 'ex1', kind: 'extrude', extrude: { sketch: '@sk1', distance: 10, direction: 'normal', operation: 'new' } },
      ...(mirror
        ? [{ id: 'mi1', kind: 'mirror', mirror: { body: 'body_ex1', plane: 'Right', keep_original: true, merge: true } }]
        : []),
    ],
  }
}

/** How many planar faces point up (+Y): the top face, split at the mirror plane
 *  until the merge folds the halves. The half-cube's sketch is on Front, so its
 *  "up" is world +Y. */
function upFaces(ocModule: OccModule, h: SharedHarness, snapshot: Record<string, Body>, bodyId: string): number {
  const body = snapshot[bodyId]
  if (!body || body.shape === null) return -1
  const scope = new DisposeScope()
  try {
    const shape = h.table.get<OccShape>(body.shape)
    let n = 0
    for (const face of exploreFaces(ocModule, scope, shape)) {
      try {
        if (faceNormal(ocModule, scope, face)[1] > 1 - 1e-6) n++
      } catch {
        // Curved face; not a top candidate.
      }
    }
    return n
  } finally {
    scope.dispose()
  }
}

function lastSnapshot(result: BuildResponse): Record<string, Body> {
  const state = result._build_state as BuildState
  const last = state.feature_order[state.feature_order.length - 1]
  return state.checkpoints[last].body_store_snapshot
}

function faceCount(ocModule: OccModule, h: SharedHarness, snapshot: Record<string, Body>, bodyId: string): number {
  const body = snapshot[bodyId]
  if (!body || body.shape === null) return -1
  const scope = new DisposeScope()
  try {
    return exploreFaces(ocModule, scope, h.table.get<OccShape>(body.shape)).length
  } finally {
    scope.dispose()
  }
}

/** A shallow store copy safe to hand to a solver: live B-rep handles are
 *  numbers, but `brep_diff`'s sub-shape proxies are not ours to copy. */
function cloneStore(snapshot: Record<string, Body>): Record<string, Body> {
  const out: Record<string, Body> = {}
  for (const [id, body] of Object.entries(snapshot)) {
    out[id] = {
      ...body,
      modified_by: [...body.modified_by],
      profile_queries: [...body.profile_queries],
      brep_diff: null,
    }
  }
  return out
}

describe.skipIf(!oc)('mirror precision (real OCC)', () => {
  const h = extrudeTestHarness()

  it('the five half-cube cases keep the control table face counts (6, 6, 6, 10, 6)', () => {
    const cases: [string, number, Record<string, unknown>[], number][] = [
      ['horizontal/vertical, 0 DOF', 0, [...corners,
        { id: 'h1', kind: 'horizontal', target: '$bottom' },
        { id: 'h2', kind: 'horizontal', target: '$top' },
        { id: 'v1', kind: 'vertical', target: '$right' },
        { id: 'v2', kind: 'vertical', target: '$left' },
        ...sizes,
        { id: 'o1', kind: 'coincident', a: '@builtin_origin', b: '$leftstart' },
      ], 6],
      ['normals + lengths + midpoint + x pin, tilted seed', 1e-2,
        [...corners, ...normals, ...sizes, originPin, rotationPin], 6],
      ['the same minus the x pin, exactly square', 0,
        [...corners, ...normals, ...sizes, originPin], 6],
      ['the same, seeded rotated 1e-6 rad', 1e-6,
        [...corners, ...normals, ...sizes, originPin], 10],
      ['top horizontal, bottom parallel, 0 DOF', 1e-6, [...corners,
        { id: 'h1', kind: 'horizontal', target: '$top' },
        { id: 'p1', kind: 'parallel', a: '$bottom', b: '$top' },
        ...sizes, originPin, rotationPin,
      ], 6],
    ]
    const counts: number[] = []
    for (const [, theta, constraints] of cases) {
      const result = h.run(halfCubeDoc(halfCubeSketch(theta, constraints)))
      expect(h.res(result, 'ex1').status).toBe('ok')
      expect(h.res(result, 'mi1').status).toBe('ok')
      counts.push(faceCount(oc!, h, lastSnapshot(result), 'body_ex1'))
    }
    expect(counts).toEqual([6, 6, 6, 10, 6])
  })

  it('keeps the authored 1e-6 rad tilt: 10 faces and the 2e-5-wide wedge', () => {
    // The free rotation is the only DOF, so the seed's tilt survives the solve
    // untouched. The two near-vertical walls that meet at x = 0 are therefore
    // each 1e-6 rad off the mirror plane, in opposite directions: their normals
    // differ by 2e-6, which is the 2e-5-wide wedge over the 10-unit half-height.
    const result = h.run(halfCubeDoc(halfCubeSketch(1e-6, [...corners, ...normals, ...sizes, originPin])))
    const row = h.res(result, 'sk1')
    expect(row.status).toBe('underconstrained')
    expect(row.dof).toBe(1)
    expect(faceCount(oc!, h, lastSnapshot(result), 'body_ex1')).toBe(10)
    // The solved left edge runs from -1e-5 to +1e-5 across the 20-tall side.
    const left = (row.geometry as Record<string, number[]>).left
    expect(Math.abs(left[0] - -1e-5)).toBeLessThan(1e-9)
    expect(Math.abs(left[2] - 1e-5)).toBeLessThan(1e-9)

    const body = lastSnapshot(result).body_ex1
    const scope = new DisposeScope()
    try {
      const shape = h.table.get<OccShape>(body.shape!)
      const normals: number[][] = []
      for (const face of exploreFaces(oc!, scope, shape)) {
        try {
          normals.push([...faceNormal(oc!, scope, face)])
        } catch {
          // A curved face; this fixture has none.
        }
      }
      // The two outer side walls are the authored tilt: each is 1e-6 rad off
      // the world plane, in opposite directions, which is what opens the
      // 2e-5-wide wedge at the bottom of the half-cube.
      const sideWalls = normals.filter((n) => Math.abs(n[0]) > 0.99 && Math.abs(n[1]) > 1e-7)
      expect(sideWalls.length).toBeGreaterThanOrEqual(2)
      for (const n of sideWalls) expect(Math.abs(n[1])).toBeCloseTo(1e-6, 9)
    } finally {
      scope.dispose()
    }
  })

  it('the body record carries the solve report and the mirror merge keeps it', () => {
    // The sketch itself is exact (a 0-DOF rectangle), so the report is the
    // contract floor on both axes; what matters is that the record exists, names
    // the sketch, and is what the merge read.
    const result = h.run(halfCubeDoc(halfCubeSketch(0, [...corners, ...normals, ...sizes, originPin, rotationPin])))
    const row = h.res(result, 'sk1')
    const expected = contractPrecision(row.angular_miss, row.linear_miss, 'sk1')
    expect(expected).toEqual({ angular: OCC_ANGULAR, linear: OCC_CONFUSION, sketch: 'sk1' })
    expect(lastSnapshot(result).body_ex1.precision).toEqual(expected)
  })

  it('reads an inherited precision: a 5e-11 seam folds only once the record says so', () => {
    // A 1-DOF half-cube seeded 5e-11 rad off the mirror plane: the facing walls
    // differ by 1e-10, inside a reported 1e-10 and outside the contract's 1e-12.
    const build = new SharedHarness(oc!)
    const result = build.run(halfCubeDoc(
      halfCubeSketch(5e-11, [...corners, ...normals, ...sizes, originPin]), false,
    ))
    expect(build.res(result, 'ex1').status).toBe('ok')
    const snapshot = lastSnapshot(result)

    const mirror = (precision: Body['precision']): { faces: number; up: number; warning?: string } => {
      const store = cloneStore(snapshot)
      if (precision !== undefined) store.body_ex1.precision = precision
      else delete store.body_ex1.precision
      const scope = new DisposeScope()
      try {
        const res = solveMirror(oc!, scope, build.table, {
          id: 'mi1', kind: 'mirror',
          mirror: { body: 'body_ex1', plane: 'Right', keep_original: true, merge: true },
        }, initGlobalRepo(), store)
        const body = store[res.body_id]
        const faces = body?.shape != null
          ? exploreFaces(oc!, scope, build.table.get<OccShape>(body.shape)).length
          : -1
        return { faces, up: body?.shape != null ? upFaces(oc!, build, store, res.body_id) : -1, warning: res.solver_warning }
      } finally {
        scope.dispose()
      }
    }

    // No report: the merge reads the contract and the two top halves stay apart.
    const base = mirror(undefined)
    expect(base.up).toBe(2)
    expect(base.faces).toBe(8)
    // The report (2e-10 rad) folds the top pair; the body record rides along.
    const widened = mirror({ angular: 2e-10, linear: OCC_CONFUSION, sketch: 'sk1' })
    expect(widened.up).toBe(1)
    expect(widened.faces).toBe(6)
    expect(widened.warning).toBeUndefined()
    // A report past the ceiling still folds this seam (1e-10 < 1e-9) but says
    // the merge was clamped, naming the sketch and its realised precision.
    const clamped = mirror({ angular: 5e-9, linear: OCC_CONFUSION, sketch: 'sk1' })
    expect(clamped.up).toBe(1)
    expect(clamped.warning).toContain(
      "sketch sk1 solved to 5e-9 rad, above the kernel's 1e-9 merge ceiling",
    )
  })
})
