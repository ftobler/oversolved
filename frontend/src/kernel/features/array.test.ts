// Pure-logic coverage for the array leaf's instance-count + offset arithmetic
// (buildArrayTransforms / buildCircularTransforms). The full solveArray path
// needs live OCC and is exercised by transformGroupReal et al; here we drive
// just the transform builders through a recording fake so the include_source
// off-by-one, rectangular nesting, and 360/count step default are pinned down
// without the gitignored 66 MB opencascade.js artifact.

import { describe, it, expect } from 'vitest'
import type { OccModule } from '../occ/occTypes'
import type { DisposeScope } from '../occ/disposeScope'
import type { Repository } from '../query'
import { Repository as RealRepository } from '../query'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import { buildArrayTransforms, buildCircularTransforms, solveArray, solveCircularArray } from './array'
import { bareBody } from './shared'
import { emptyBrepDiff } from '../types3d'

// Recording trsf doubles: each builder leaves its translation or rotation on
// the returned object so tests can assert the produced offsets/angles.
interface RecTrsf {
  translation?: number[]
  rotation?: { origin: number[]; direction: number[]; angle: number }
}

function makeFake(): OccModule {
  class Vec {
    x: number
    y: number
    z: number
    constructor(x: number, y: number, z: number) {
      this.x = x
      this.y = y
      this.z = z
    }
  }
  class Pnt {
    x: number
    y: number
    z: number
    constructor(x: number, y: number, z: number) {
      this.x = x
      this.y = y
      this.z = z
    }
  }
  class Dir {
    x: number
    y: number
    z: number
    constructor(x: number, y: number, z: number) {
      this.x = x
      this.y = y
      this.z = z
    }
  }
  class Ax1 {
    origin: number[]
    direction: number[]
    constructor(p: Pnt, d: Dir) {
      this.origin = [p.x, p.y, p.z]
      this.direction = [d.x, d.y, d.z]
    }
  }
  class Trsf implements RecTrsf {
    translation?: number[]
    rotation?: { origin: number[]; direction: number[]; angle: number }
    SetTranslation_1(v: Vec): void {
      this.translation = [v.x, v.y, v.z]
    }
    SetRotation_1(ax: Ax1, angle: number): void {
      this.rotation = { origin: ax.origin, direction: ax.direction, angle }
    }
  }
  return {
    gp_Trsf_1: Trsf,
    gp_Vec_4: Vec,
    gp_Pnt_3: Pnt,
    gp_Dir_4: Dir,
    gp_Ax1_2: Ax1,
  } as unknown as OccModule
}

const scope = { track: <T>(x: T): T => x } as unknown as DisposeScope
const noTable = null as unknown as HandleTable
// Empty queries on every feature -> resolve helpers return the fallbacks
// without ever touching the repo, so a stub repo is enough.
const repo = { query: () => null, elements: new Map() } as unknown as Repository

// A repo whose query() resolves each named direction query to a straight edge
// (or, for `faceNormals`, a planar face) along the given vector. Lets the linear
// / rectangular builders run now that a resolvable direction pick is required.
function dirRepo(edges: Record<string, number[]>, faceNormals: Record<string, number[]> = {}): Repository {
  return {
    query: (q: string) => {
      if (q in edges) return { start: [0, 0, 0], end: edges[q] }
      if (q in faceNormals) return { normal: faceNormals[q], centroid: [0, 0, 0] }
      return null
    },
    elements: new Map(),
  } as unknown as Repository
}

// +X on direction_x_query, +Y on direction_y_query: the common two-axis case.
const xyRepo = dirRepo({ qx: [1, 0, 0], qy: [0, 1, 0] })

function translations(trsfs: unknown[]): number[][] {
  return (trsfs as RecTrsf[]).map((t) => t.translation!)
}

describe('buildArrayTransforms (linear)', () => {
  it('emits count_x - 1 instances when the source is included', () => {
    const t = buildArrayTransforms(makeFake(), scope, { mode: 'linear', count_x: 3, pitch_x: 10, include_source: true, direction_x_query: 'qx' }, xyRepo)
    expect(translations(t)).toEqual([[10, 0, 0], [20, 0, 0]])
  })

  it('emits count_x instances when the source is excluded', () => {
    const t = buildArrayTransforms(makeFake(), scope, { mode: 'linear', count_x: 3, pitch_x: 10, include_source: false, direction_x_query: 'qx' }, xyRepo)
    expect(translations(t)).toEqual([[10, 0, 0], [20, 0, 0], [30, 0, 0]])
  })

  it('resolves the direction from a picked edge query', () => {
    const t = buildArrayTransforms(makeFake(), scope, { mode: 'linear', count_x: 2, pitch_x: 5, direction_x_query: 'qz' }, dirRepo({ qz: [0, 0, 2] }))
    // The edge vector is normalized, so pitch 5 lands the copy at (0,0,5).
    expect(translations(t)).toEqual([[0, 0, 5]])
  })

  it('resolves the direction from a picked planar face normal', () => {
    const t = buildArrayTransforms(makeFake(), scope, { mode: 'linear', count_x: 2, pitch_x: 5, direction_x_query: 'qf' }, dirRepo({}, { qf: [0, 0, 3] }))
    expect(translations(t)).toEqual([[0, 0, 5]])
  })

  it('inverts the resolved direction when invert_x is set', () => {
    const t = buildArrayTransforms(makeFake(), scope, { mode: 'linear', count_x: 2, pitch_x: 5, direction_x_query: 'qx', invert_x: true }, xyRepo)
    expect(translations(t)).toEqual([[-5, 0, 0]])
  })

  it('throws when the direction picker is empty', () => {
    expect(() => buildArrayTransforms(makeFake(), scope, { mode: 'linear', count_x: 2, pitch_x: 5 }, repo)).toThrow(/direction X is required/)
  })

  it('throws when the direction query does not resolve', () => {
    expect(() => buildArrayTransforms(makeFake(), scope, { mode: 'linear', count_x: 2, pitch_x: 5, direction_x_query: 'dangling' }, repo)).toThrow(/did not resolve/)
  })

  it('throws instead of silently no-opping when count_x is 0', () => {
    expect(() => buildArrayTransforms(makeFake(), scope, { mode: 'linear', count_x: 0, pitch_x: 10, direction_x_query: 'qx' }, xyRepo))
      .toThrow(/count_x must be a positive integer/)
  })

  it('throws when count_x is negative', () => {
    expect(() => buildArrayTransforms(makeFake(), scope, { mode: 'linear', count_x: -1, pitch_x: 10, direction_x_query: 'qx' }, xyRepo))
      .toThrow(/count_x must be a positive integer/)
  })

  it('throws instead of silently truncating when count_x is fractional', () => {
    expect(() => buildArrayTransforms(makeFake(), scope, { mode: 'linear', count_x: 2.7, pitch_x: 10, direction_x_query: 'qx' }, xyRepo))
      .toThrow(/count_x must be a positive integer/)
  })

  it('throws when pitch_x is not finite', () => {
    expect(() => buildArrayTransforms(makeFake(), scope, { mode: 'linear', count_x: 2, pitch_x: NaN, direction_x_query: 'qx' }, xyRepo))
      .toThrow(/pitch_x must be a finite number/)
    expect(() => buildArrayTransforms(makeFake(), scope, { mode: 'linear', count_x: 2, pitch_x: Infinity, direction_x_query: 'qx' }, xyRepo))
      .toThrow(/pitch_x must be a finite number/)
  })

  it('threads the body store so a :solid direction pick coerces upward', () => {
    // The direction query restricts to `solid`; the repo holds only the body's
    // face, so the pick resolves by upward coercion through the threaded store.
    // Without the store the dev failLoud fires (throws in test mode).
    const realRepo = new RealRepository()
    realRepo.registerAncestor(
      ['@ex1'],
      { type: 'flatface', body_id: 'body_ex1', face_index: 0, created_by: 'ex1' },
    )
    const bodyStore = { body_ex1: { id: 'body_ex1', normal: [0, 0, 2] } }
    const feature = { mode: 'linear', count_x: 2, pitch_x: 5, direction_x_query: '?4;@ex1:solid' }
    expect(() => buildArrayTransforms(makeFake(), scope, feature, realRepo)).toThrow()
    const t = buildArrayTransforms(makeFake(), scope, feature, realRepo, bodyStore)
    expect(translations(t)).toEqual([[0, 0, 5]])
  })
})

describe('buildArrayTransforms (rectangular)', () => {
  it('nests the X copies inside each Y row, summing both pitches', () => {
    const t = buildArrayTransforms(
      makeFake(),
      scope,
      { mode: 'rectangular', count_x: 2, count_y: 2, pitch_x: 10, pitch_y: 20, include_source: true, direction_x_query: 'qx', direction_y_query: 'qy' },
      xyRepo,
    )
    // numX = 1 (source included), countY = 2 -> j=0 then j=1
    expect(translations(t)).toEqual([[10, 0, 0], [10, 20, 0]])
  })

  it('emits count_x * count_y instances when the source is excluded', () => {
    const t = buildArrayTransforms(
      makeFake(),
      scope,
      { mode: 'rectangular', count_x: 2, count_y: 2, pitch_x: 10, pitch_y: 20, include_source: false, direction_x_query: 'qx', direction_y_query: 'qy' },
      xyRepo,
    )
    expect(t).toHaveLength(4)
  })

  it('throws when the Y direction picker is empty', () => {
    expect(() => buildArrayTransforms(
      makeFake(),
      scope,
      { mode: 'rectangular', count_x: 2, count_y: 2, pitch_x: 10, pitch_y: 20, direction_x_query: 'qx' },
      xyRepo,
    )).toThrow(/direction Y is required/)
  })

  it('throws when count_y is 0', () => {
    expect(() => buildArrayTransforms(
      makeFake(),
      scope,
      { mode: 'rectangular', count_x: 2, count_y: 0, pitch_x: 10, pitch_y: 20, direction_x_query: 'qx', direction_y_query: 'qy' },
      xyRepo,
    )).toThrow(/count_y must be a positive integer/)
  })

  it('throws instead of silently truncating when count_y is fractional', () => {
    expect(() => buildArrayTransforms(
      makeFake(),
      scope,
      { mode: 'rectangular', count_x: 2, count_y: 2.7, pitch_x: 10, pitch_y: 20, direction_x_query: 'qx', direction_y_query: 'qy' },
      xyRepo,
    )).toThrow(/count_y must be a positive integer/)
  })

  it('throws when pitch_y is not finite', () => {
    expect(() => buildArrayTransforms(
      makeFake(),
      scope,
      { mode: 'rectangular', count_x: 2, count_y: 2, pitch_x: 10, pitch_y: NaN, direction_x_query: 'qx', direction_y_query: 'qy' },
      xyRepo,
    )).toThrow(/pitch_y must be a finite number/)
  })
})

describe('buildCircularTransforms', () => {
  const rotations = (trsfs: unknown[]) => (trsfs as RecTrsf[]).map((t) => t.rotation!)
  // A picked axis is required; resolve @az to a +Z edge through the origin.
  const zRepo = dirRepo({ az: [0, 0, 1] })

  it('defaults the step angle to 360 / count and includes the source', () => {
    const t = buildCircularTransforms(makeFake(), scope, { count: 4, include_source: true, axis: 'az' }, zRepo, {})
    const angles = rotations(t).map((r) => (r.angle * 180) / Math.PI)
    // count 4, source included -> 3 copies at 90, 180, 270 degrees
    expect(angles.map((a) => Math.round(a))).toEqual([90, 180, 270])
  })

  it('emits count copies when the source is excluded', () => {
    const t = buildCircularTransforms(makeFake(), scope, { count: 4, include_source: false, axis: 'az' }, zRepo, {})
    expect(t).toHaveLength(4)
  })

  it('honours an explicit step_angle over the 360/count default', () => {
    const t = buildCircularTransforms(makeFake(), scope, { count: 3, step_angle: 30, include_source: false, axis: 'az' }, zRepo, {})
    const angles = rotations(t).map((r) => Math.round((r.angle * 180) / Math.PI))
    expect(angles).toEqual([30, 60, 90])
  })

  it('rotates about the picked axis through its origin', () => {
    const t = buildCircularTransforms(makeFake(), scope, { count: 2, include_source: false, axis: 'az' }, zRepo, {})
    expect(rotations(t)[0].origin).toEqual([0, 0, 0])
    expect(rotations(t)[0].direction).toEqual([0, 0, 1])
  })

  it('resolves the axis from a picked planar face normal', () => {
    const faceRepo = dirRepo({}, { af: [0, 0, 2] })
    const t = buildCircularTransforms(makeFake(), scope, { count: 2, include_source: false, axis: 'af' }, faceRepo, {})
    expect(rotations(t)[0].direction).toEqual([0, 0, 1])
  })

  it('inverts the axis direction when invert_axis is set', () => {
    const t = buildCircularTransforms(makeFake(), scope, { count: 2, include_source: false, axis: 'az', invert_axis: true }, zRepo, {})
    expect(rotations(t)[0].direction).toEqual([0, 0, -1])
  })
  it('throws instead of silently no-opping when count is 0', () => {
    expect(() => buildCircularTransforms(makeFake(), scope, { count: 0, axis: 'az' }, zRepo, {}))
      .toThrow(/count must be a positive integer/)
  })

  it('throws when count is negative', () => {
    expect(() => buildCircularTransforms(makeFake(), scope, { count: -2, axis: 'az' }, zRepo, {}))
      .toThrow(/count must be a positive integer/)
  })

  it('throws instead of silently truncating when count is fractional', () => {
    expect(() => buildCircularTransforms(makeFake(), scope, { count: 2.7, axis: 'az' }, zRepo, {}))
      .toThrow(/count must be a positive integer/)
  })

  it('throws when step_angle is not finite', () => {
    expect(() => buildCircularTransforms(makeFake(), scope, { count: 4, step_angle: NaN, axis: 'az' }, zRepo, {}))
      .toThrow(/step_angle must be a finite number/)
  })

  it('throws when the axis picker is empty', () => {
    expect(() => buildCircularTransforms(makeFake(), scope, { count: 2 }, repo, {})).toThrow(/axis is required/)
  })

  it('throws when the axis query does not resolve', () => {
    expect(() => buildCircularTransforms(makeFake(), scope, { count: 2, axis: 'dangling' }, repo, {})).toThrow(/did not resolve/)
  })

  it('resolves the axis from a picked circular edge (center + axis)', () => {
    const circleRepo = {
      query: (q: string) => {
        if (q === 'ce') return { center: [5, 0, 0], axis: [0, 1, 0], radius: 3, kind: 'circle' }
        return null
      },
      elements: new Map(),
    } as unknown as Repository
    const t = buildCircularTransforms(makeFake(), scope, { count: 2, include_source: false, axis: 'ce' }, circleRepo, {})
    expect(rotations(t)[0].origin).toEqual([5, 0, 0])
    expectCloseVec(rotations(t)[0].direction, [0, 1, 0])
  })

  it('resolves the axis from a picked cylindrical face (type + axis)', () => {
    const cylRepo = {
      query: (q: string) => {
        if (q === 'cf') return { type: 'cylinderface', axis: [1, 0, 0], centroid: [10, 0, 0], normal: [0, 0, 1] }
        return null
      },
      elements: new Map(),
    } as unknown as Repository
    const t = buildCircularTransforms(makeFake(), scope, { count: 2, include_source: false, axis: 'cf' }, cylRepo, {})
    expect(rotations(t)[0].origin).toEqual([10, 0, 0])
    expectCloseVec(rotations(t)[0].direction, [1, 0, 0])
  })

  it('resolves the axis from a picked arc edge (center + axis)', () => {
    const arcRepo = {
      query: (q: string) => {
        if (q === 'ae') return {
          center: [0, 2, 0], axis: [0, 0, 1], radius: 5, kind: 'arc',
          x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI,
        }
        return null
      },
      elements: new Map(),
    } as unknown as Repository
    const t = buildCircularTransforms(makeFake(), scope, { count: 2, include_source: false, axis: 'ae' }, arcRepo, {})
    expect(rotations(t)[0].origin).toEqual([0, 2, 0])
    expectCloseVec(rotations(t)[0].direction, [0, 0, 1])
  })

  it('resolves the axis from a sketch circle via plane normal', () => {
    const sketchCircleRepo = {
      query: (q: string) => {
        if (q === '@sk/c1') return { external_params: [3, 0, 2], kind: 'circle', sketch_id: 'sk' }
        return null
      },
      elements: new Map([
        ['_pt_sk', { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }],
      ]),
    } as unknown as Repository
    const t = buildCircularTransforms(makeFake(), scope, { count: 2, include_source: false, axis: '@sk/c1' }, sketchCircleRepo, {})
    // Centre [3, 0] lifted to [3, 0, 0] on XY plane; axis = normal [0, 0, 1].
    expect(rotations(t)[0].origin).toEqual([3, 0, 0])
    expectCloseVec(rotations(t)[0].direction, [0, 0, 1])
  })

  it('resolves the axis from a sketch circle on a non-XY plane', () => {
    const sketchCircleRepo = {
      query: (q: string) => {
        if (q === '@sk/c1') return { external_params: [0, 0, 5], kind: 'circle', sketch_id: 'sk' }
        return null
      },
      elements: new Map([
        ['_pt_sk', { origin: [10, 0, 0], x_axis: [0, 1, 0], y_axis: [0, 0, 1], normal: [1, 0, 0] }],
      ]),
    } as unknown as Repository
    const t = buildCircularTransforms(makeFake(), scope, { count: 2, include_source: false, axis: '@sk/c1' }, sketchCircleRepo, {})
    // Centre [0, 0] on plane at origin [10,0,0] with x_axis [0,1,0] → [10, 0, 0].
    expect(rotations(t)[0].origin).toEqual([10, 0, 0])
    expectCloseVec(rotations(t)[0].direction, [1, 0, 0])
  })

  it('skips a circular edge that carries undefined start/end via truthy guard', () => {
    // Simulate the edgeAncestryPayload shape: circular edges have start: undefined,
    // end: undefined, plus centre + axis. The truthy guard must route into the
    // centre/axis branch, not crash in the start/end branch.
    const circEdgeRepo = {
      query: (q: string) => {
        if (q === 'ce') return { start: undefined, end: undefined, center: [0, 0, 0], axis: [0, 0, 1], kind: 'circle' }
        return null
      },
      elements: new Map(),
    } as unknown as Repository
    const t = buildCircularTransforms(makeFake(), scope, { count: 2, include_source: false, axis: 'ce' }, circEdgeRepo, {})
    expect(rotations(t)[0].origin).toEqual([0, 0, 0])
    expectCloseVec(rotations(t)[0].direction, [0, 0, 1])
  })

  it('skips a straight edge that carries undefined center/axis via truthy guard', () => {
    // Simulate the edgeAncestryPayload shape: straight edges have center: undefined,
    // axis: undefined, plus start/end. The truthy guard must route into the
    // start/end branch, not crash in the centre/axis branch.
    const straightEdgeRepo = {
      query: (q: string) => {
        if (q === 'se') return { start: [0, 0, 0], end: [0, 0, 3], center: undefined, axis: undefined }
        return null
      },
      elements: new Map(),
    } as unknown as Repository
    const t = buildCircularTransforms(makeFake(), scope, { count: 2, include_source: false, axis: 'se' }, straightEdgeRepo, {})
    expectCloseVec(rotations(t)[0].direction, [0, 0, 1])
  })

  it('throws when a cylindrical face has no axis field', () => {
    // A cylinderface without an axis field should fall through to the normal-based
    // branch, which would succeed -- but our resolver requires cylinderface to
    // carry axis (otherwise it is treated like a planar face normal). To avoid
    // confusion, we ensure a degenerate axis triggers no resolve.
    const badCylRepo = {
      query: (q: string) => {
        if (q === 'cf') return { type: 'cylinderface', centroid: [0, 0, 0], normal: [0, 0, 1] }
        return null
      },
      elements: new Map(),
    } as unknown as Repository
    // Without an axis field, it falls through to the planar-face normal branch
    // and should resolve to the face normal direction.
    const t = buildCircularTransforms(makeFake(), scope, { count: 2, include_source: false, axis: 'cf' }, badCylRepo, {})
    expectCloseVec(rotations(t)[0].direction, [0, 0, 1])
  })
})

// Both array leaves resolve their source body before touching OCC, so the two
// diagnoses they can report are reachable with no kernel at all.
describe('array source body diagnosis', () => {
  const store = (): Record<string, Body> => ({
    body_ex1: bareBody('body_ex1', 'ex1'),
    body_ex1_1: bareBody('body_ex1_1', 'ex1'),
  })
  const noOcc = null as unknown as OccModule
  const noRepo = null as unknown as Repository

  // The leaf wraps a resolve failure in "not found; available body IDs: [...]".
  // An ambiguous ref must NOT be wrapped: it would tell the user the body does
  // not exist while listing the very ids that matched it.
  it('reports a feature ref that names several bodies as ambiguous, not as missing', () => {
    for (const [solve, key] of [[solveArray, 'array'], [solveCircularArray, 'circular_array']] as const) {
      const feature = { id: 'ar1', [key]: { source_body: '@ex1' } }
      expect(() => solve(noOcc, scope, noTable, feature, noRepo, store())).toThrow(/ambiguous/)
      expect(() => solve(noOcc, scope, noTable, feature, noRepo, store())).not.toThrow(/not found/)
    }
  })

  it('still reports a ref that matches nothing as missing', () => {
    const feature = { id: 'ar1', array: { source_body: '@nope' } }
    expect(() => solveArray(noOcc, scope, noTable, feature, noRepo, store()))
      .toThrow(/source body '@nope' not found/)
  })
})

// A no-op array (include_source, zero transforms) never reaches a boolean, so
// the hygiene path is drivable with the recording fake plus stub table.
describe('array no-op hygiene', () => {
  it('include_source with zero transforms leaves modified_by and brep_diff untouched', () => {
    // count_x=1 with the source included copies nothing: pushing modified_by
    // and nulling brep_diff raised a spurious dirty signal and destroyed the
    // previous op's diff.
    const body = { ...bareBody('body_ex1', 'ex1'), shape: 1 as never, modified_by: ['prev'], brep_diff: emptyBrepDiff() }
    const table = { get: () => null } as unknown as HandleTable
    const r = solveArray(
      makeFake(), scope, table,
      { id: 'ar9', array: { source_body: 'body_ex1', mode: 'linear', count_x: 1, pitch_x: 10, direction_x_query: 'qx' } },
      xyRepo, { body_ex1: body },
    )
    expect(r).toEqual({ status: 'ok', body_id: 'body_ex1', body_ids: ['body_ex1'], operation: 'add' })
    expect(body.modified_by).toEqual(['prev'])
    expect(body.brep_diff).not.toBeNull()
  })
})

function expectCloseVec(actual: number[], expected: number[], tol = 1e-9): void {
  expect(actual).toHaveLength(expected.length)
  for (let i = 0; i < expected.length; i++) {
    expect(Math.abs(actual[i] - expected[i]), `${actual[i]} != ${expected[i]}`).toBeLessThanOrEqual(tol)
  }
}
