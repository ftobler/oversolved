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
import { buildArrayTransforms, buildCircularTransforms } from './array'

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
})

describe('buildCircularTransforms', () => {
  const rotations = (trsfs: unknown[]) => (trsfs as RecTrsf[]).map((t) => t.rotation!)

  it('defaults the step angle to 360 / count and includes the source', () => {
    const t = buildCircularTransforms(makeFake(), scope, { count: 4, include_source: true }, repo, {})
    const angles = rotations(t).map((r) => (r.angle * 180) / Math.PI)
    // count 4, source included -> 3 copies at 90, 180, 270 degrees
    expect(angles.map((a) => Math.round(a))).toEqual([90, 180, 270])
  })

  it('emits count copies when the source is excluded', () => {
    const t = buildCircularTransforms(makeFake(), scope, { count: 4, include_source: false }, repo, {})
    expect(t).toHaveLength(4)
  })

  it('honours an explicit step_angle over the 360/count default', () => {
    const t = buildCircularTransforms(makeFake(), scope, { count: 3, step_angle: 30, include_source: false }, repo, {})
    const angles = rotations(t).map((r) => Math.round((r.angle * 180) / Math.PI))
    expect(angles).toEqual([30, 60, 90])
  })

  it('rotates about the default Z axis through the origin', () => {
    const t = buildCircularTransforms(makeFake(), scope, { count: 2, include_source: false }, repo, {})
    expect(rotations(t)[0].origin).toEqual([0, 0, 0])
    expect(rotations(t)[0].direction).toEqual([0, 0, 1])
  })
})
