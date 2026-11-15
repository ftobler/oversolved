// Pure-logic coverage for the two pattern leaves' instance arithmetic. The full
// solve path needs live OCC and is exercised by the *Real suites; here the copy
// builders run through a recording fake so the source-in-count off-by-one, the
// second direction's nesting, and the circular angle law are pinned down without
// the gitignored OCC build artifact.

import { describe, it, expect } from 'vitest'
import type { OccModule } from '../../occ/occTypes'
import type { DisposeScope } from '../../occ/disposeScope'
import type { Repository } from '../../query'
import { Repository as RealRepository } from '../../query'
import type { HandleTable } from '../../occ/handleTable'
import type { Body } from '../../types3d'
import { buildLinearCopies, solveLinearPattern } from '../linearPattern'
import { buildCircularCopies, solveCircularPattern } from '../circularPattern'
import { bareBody } from '../shared/bodyResolution'

type Dict = Record<string, unknown>

function buildLinear(
  oc: OccModule,
  scope: DisposeScope,
  sub: Dict,
  repo: Repository,
  bodyStore: Record<string, Body> = {},
) {
  return buildLinearCopies(oc, scope, sub, repo, bodyStore).copies.map((copy) => copy.trsf)
}

function buildCircular(
  oc: OccModule,
  scope: DisposeScope,
  sub: Dict,
  repo: Repository,
  bodyStore: Record<string, Body> = {},
) {
  return buildCircularCopies(oc, scope, sub, repo, bodyStore).copies.map((copy) => copy.trsf)
}

function solveLinear(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  repo: Repository,
  store: Record<string, Body>,
) {
  return solveLinearPattern(oc, scope, table, {
    ...feature,
    linear_pattern: { subject: 'body', ...(feature.linear_pattern as Dict) },
  }, repo, store)
}

function solveCircular(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  repo: Repository,
  store: Record<string, Body>,
) {
  return solveCircularPattern(oc, scope, table, {
    ...feature,
    circular_pattern: { subject: 'body', ...(feature.circular_pattern as Dict) },
  }, repo, store)
}

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
    gp_Dir_5: Dir,
    gp_Ax1_2: Ax1,
  } as unknown as OccModule
}

const scope = { track: <T>(x: T): T => x } as unknown as DisposeScope
const noTable = null as unknown as HandleTable
// Empty queries on every feature -> resolve helpers return the fallbacks
// without ever touching the repo, so a stub repo is enough.
const repo = { query: () => null, elements: new Map() } as unknown as Repository

// A repo whose query() resolves each named direction query to a straight edge
// (or, for `faceNormals`, a planar face) along the given vector. Lets the
// direction builders run now that a resolvable pick is required.
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

// +X on qx, +Y on qy: the common two-direction case.
const xyRepo = dirRepo({ qx: [1, 0, 0], qy: [0, 1, 0] })

function translations(trsfs: unknown[]): number[][] {
  // A zero component can arrive as -0 (a negative index times a zero direction
  // component); compare it as 0, which is the number it means.
  return (trsfs as RecTrsf[]).map((t) => t.translation!.map((n) => (n === 0 ? 0 : n)))
}

describe('buildLinearCopies (one direction)', () => {
  it('emits count - 1 instances because the count includes the source', () => {
    const t = buildLinear(makeFake(), scope, { count: 3, pitch: 10, direction_query: 'qx' }, xyRepo)
    expect(translations(t)).toEqual([[10, 0, 0], [20, 0, 0]])
  })

  it('emits one copy for count 2', () => {
    const t = buildLinear(makeFake(), scope, { count: 2, pitch: 10, direction_query: 'qx' }, xyRepo)
    expect(translations(t)).toEqual([[10, 0, 0]])
  })

  it('resolves the direction from a picked edge query', () => {
    const t = buildLinear(makeFake(), scope, { count: 2, pitch: 5, direction_query: 'qz' }, dirRepo({ qz: [0, 0, 2] }))
    // The edge vector is normalized, so pitch 5 lands the copy at (0,0,5).
    expect(translations(t)).toEqual([[0, 0, 5]])
  })

  it('resolves the direction from a picked planar face normal', () => {
    const t = buildLinear(makeFake(), scope, { count: 2, pitch: 5, direction_query: 'qf' }, dirRepo({}, { qf: [0, 0, 3] }))
    expect(translations(t)).toEqual([[0, 0, 5]])
  })

  it('inverts the resolved direction when invert is set', () => {
    const t = buildLinear(makeFake(), scope, { count: 2, pitch: 5, direction_query: 'qx', invert: true }, xyRepo)
    expect(translations(t)).toEqual([[-5, 0, 0]])
  })

  it('honours a stored direction vector when no query is set', () => {
    const t = buildLinear(makeFake(), scope, { count: 2, pitch: 5, direction: [0, 0, -2] }, repo)
    expect(translations(t)).toEqual([[0, 0, -5]])
  })

  it('normalises a non-unit stored direction vector', () => {
    const t = buildLinear(makeFake(), scope, { count: 2, pitch: 10, direction: [3, 4, 0] }, repo)
    expectCloseVec(translations(t)[0], [6, 8, 0])
  })

  it('an explicit direction query wins over a stored vector', () => {
    const t = buildLinear(makeFake(), scope, { count: 2, pitch: 5, direction: [0, 0, 1], direction_query: 'qx' }, xyRepo)
    expect(translations(t)).toEqual([[5, 0, 0]])
  })

  it('inverts a stored direction vector too', () => {
    const t = buildLinear(makeFake(), scope, { count: 2, pitch: 5, direction: [0, 0, 1], invert: true }, repo)
    expect(translations(t)).toEqual([[0, 0, -5]])
  })

  it('refuses a zero stored direction by name', () => {
    expect(() => buildLinear(makeFake(), scope, { count: 2, pitch: 5, direction: [0, 0, 0] }, repo))
      .toThrow(/direction must be a non-zero vector/)
  })

  it('throws when the direction picker is empty', () => {
    expect(() => buildLinear(makeFake(), scope, { count: 2, pitch: 5 }, repo)).toThrow(/direction is required/)
  })

  it('throws when the direction query does not resolve', () => {
    expect(() => buildLinear(makeFake(), scope, { count: 2, pitch: 5, direction_query: 'dangling' }, repo)).toThrow(/did not resolve/)
  })

  it('emits no copy for count 1, and refuses count 0 and negatives', () => {
    expect(buildLinear(makeFake(), scope, { count: 1, pitch: 10, direction_query: 'qx' }, xyRepo)).toEqual([])
    for (const count of [0, -1]) {
      expect(() => buildLinear(makeFake(), scope, { count, pitch: 10, direction_query: 'qx' }, xyRepo))
        .toThrow(/whole number of at least 1/)
    }
  })

  it('throws instead of silently truncating when count is fractional', () => {
    expect(() => buildLinear(makeFake(), scope, { count: 2.7, pitch: 10, direction_query: 'qx' }, xyRepo))
      .toThrow(/whole number of at least 1/)
  })

  it('throws when pitch is not finite', () => {
    expect(() => buildLinear(makeFake(), scope, { count: 2, pitch: NaN, direction_query: 'qx' }, xyRepo))
      .toThrow(/pitch must be a finite number/)
    expect(() => buildLinear(makeFake(), scope, { count: 2, pitch: Infinity, direction_query: 'qx' }, xyRepo))
      .toThrow(/pitch must be a finite number/)
  })

  it('generates the reverse side when centered', () => {
    const t = buildLinear(makeFake(), scope, { count: 3, pitch: 10, centered: true, direction_query: 'qx' }, xyRepo)
    // Instance order is ascending absolute index, positive before negative.
    expect(translations(t)).toEqual([[10, 0, 0], [-10, 0, 0], [20, 0, 0], [-20, 0, 0]])
  })

  it('threads the body store so a :solid direction pick coerces upward', () => {
    // The direction query restricts to `solid`; the repo holds only the body's
    // face, so the pick resolves by upward coercion through the threaded store.
    const realRepo = new RealRepository()
    realRepo.registerAncestor(
      ['@ex1'],
      { type: 'flatface', body_id: 'body_ex1', face_index: 0, created_by: 'ex1' },
    )
    const bodyStore = { body_ex1: { id: 'body_ex1', normal: [0, 0, 2] } } as unknown as Record<string, Body>
    const feature = { count: 2, pitch: 5, direction_query: '?4;@ex1:solid' }
    expect(() => buildLinear(makeFake(), scope, feature, realRepo)).toThrow()
    const t = buildLinear(makeFake(), scope, feature, realRepo, bodyStore)
    expect(translations(t)).toEqual([[0, 0, 5]])
  })
})

describe('buildLinearCopies (second direction)', () => {
  it('nests the direction-1 copies inside each direction-2 row, summing both pitches', () => {
    const t = buildLinear(makeFake(), scope, {
      count: 2, count_2: 2, pitch: 10, pitch_2: 20, second_direction: true,
      direction_query: 'qx', direction_2_query: 'qy',
    }, xyRepo)
    // Full 2x2 lattice minus (0,0): (1,0), (0,1), (1,1).
    expect(translations(t)).toEqual([[10, 0, 0], [0, 20, 0], [10, 20, 0]])
  })

  it('honours stored direction vectors when no queries are set', () => {
    const t = buildLinear(makeFake(), scope, {
      count: 2, count_2: 2, pitch: 10, pitch_2: 20, second_direction: true,
      direction: [1, 0, 0], direction_2: [0, 0, -1],
    }, repo)
    expect(translations(t)).toEqual([[10, 0, 0], [0, 0, -20], [10, 0, -20]])
  })

  it('accepts a 1x2 row and emits its one copy', () => {
    const t = buildLinear(makeFake(), scope, {
      count: 1, count_2: 2, pitch: 10, pitch_2: 20, second_direction: true,
      direction_query: 'qx', direction_2_query: 'qy',
    }, xyRepo)
    expect(translations(t)).toEqual([[0, 20, 0]])
  })

  it('treats a 1x1 grid as the quiet no-op, since the seed is the source', () => {
    expect(buildLinear(makeFake(), scope, {
      count: 1, count_2: 1, pitch: 10, pitch_2: 20, second_direction: true,
      direction_query: 'qx', direction_2_query: 'qy',
    }, xyRepo)).toEqual([])
  })

  it('emits count * count_2 - 1 instances for a 3x2 grid, in row-major order', () => {
    const t = buildLinear(makeFake(), scope, {
      count: 3, count_2: 2, pitch: 10, pitch_2: 20, second_direction: true,
      direction_query: 'qx', direction_2_query: 'qy',
    }, xyRepo)
    expect(t).toHaveLength(5)
    expect(translations(t)).toEqual([
      [10, 0, 0], [20, 0, 0],
      [0, 20, 0], [10, 20, 0], [20, 20, 0],
    ])
  })

  it('keeps the 2D instance keys in the retired rectangular order', () => {
    const copies = buildLinearCopies(makeFake(), scope, {
      count: 3, count_2: 2, pitch: 10, pitch_2: 20, second_direction: true,
      direction_query: 'qx', direction_2_query: 'qy',
    }, xyRepo, {}).copies
    expect(copies.map((copy) => copy.key)).toEqual(['1:0', '2:0', '0:1', '1:1', '2:1'])
  })

  it('throws when the second direction picker is empty', () => {
    expect(() => buildLinear(makeFake(), scope, {
      count: 2, count_2: 2, pitch: 10, pitch_2: 20, second_direction: true,
      direction_query: 'qx',
    }, xyRepo)).toThrow(/direction 2 is required/)
  })

  it('throws when count_2 is 0 or fractional', () => {
    for (const count2 of [0, 2.7]) {
      expect(() => buildLinear(makeFake(), scope, {
        count: 2, count_2: count2, pitch: 10, pitch_2: 20, second_direction: true,
        direction_query: 'qx', direction_2_query: 'qy',
      }, xyRepo)).toThrow(/count_2 must be a whole number of at least 1/)
    }
  })

  it('throws when pitch_2 is not finite', () => {
    expect(() => buildLinear(makeFake(), scope, {
      count: 2, count_2: 2, pitch: 10, pitch_2: NaN, second_direction: true,
      direction_query: 'qx', direction_2_query: 'qy',
    }, xyRepo)).toThrow(/pitch_2 must be a finite number/)
  })

  it('centers each direction on its own flag', () => {
    const t = buildLinear(makeFake(), scope, {
      count: 2, count_2: 3, pitch: 10, pitch_2: 5, second_direction: true,
      centered: true, centered_2: true, direction_query: 'qx', direction_2_query: 'qy',
    }, xyRepo)
    // Direction 1 offsets: 1, -1. Direction 2 rows: 0, 1, -1, 2, -2. Row-major,
    // column fastest, seed (0,0) excluded.
    expect(translations(t)).toEqual([
      [10, 0, 0], [-10, 0, 0],
      [0, 5, 0], [10, 5, 0], [-10, 5, 0],
      [0, -5, 0], [10, -5, 0], [-10, -5, 0],
      [0, 10, 0], [10, 10, 0], [-10, 10, 0],
      [0, -10, 0], [10, -10, 0], [-10, -10, 0],
    ])
  })

  it('skips an i:j cell and keeps the other copies', () => {
    const copies = buildLinearCopies(makeFake(), scope, {
      count: 2, count_2: 2, pitch: 10, pitch_2: 20, second_direction: true,
      direction_query: 'qx', direction_2_query: 'qy', skip: [[1, 1]],
    }, xyRepo, {}).copies
    expect(copies.map((copy) => copy.key)).toEqual(['1:0', '0:1'])
  })
})

describe('buildCircularCopies', () => {
  const rotations = (trsfs: unknown[]) => (trsfs as RecTrsf[]).map((t) => t.rotation!)
  // A picked axis is required; resolve az to a +Z edge through the origin.
  const zRepo = dirRepo({ az: [0, 0, 1] })
  const degrees = (trsfs: unknown[]) =>
    rotations(trsfs).map((r) => Math.round((r.angle * 180) / Math.PI))

  it('defaults to a full, evenly spaced turn: 360 / count', () => {
    const t = buildCircular(makeFake(), scope, { count: 4, axis: 'az' }, zRepo)
    // count 4 -> 3 copies at 90, 180, 270 degrees; the seed (0) is the source.
    expect(degrees(t)).toEqual([90, 180, 270])
  })

  it('puts the end instances on the sweep ends when the sweep is smaller than a turn', () => {
    const t = buildCircular(makeFake(), scope, { count: 3, angle: 180, equal_spacing: true, axis: 'az' }, zRepo)
    expect(degrees(t)).toEqual([90, 180])
  })

  it('offsets the sweep evenly around the source when centered', () => {
    const t = buildCircular(makeFake(), scope, {
      count: 2, angle: 120, equal_spacing: true, centered: true, axis: 'az',
    }, zRepo)
    // step = 120 / (2 * 1) = 60; indices -1, 0, 1 sit at -60, 0, 60.
    expect(degrees(t)).toEqual([60, -60])
  })

  it('spreads a centered full turn over 2 * count - 1 slots', () => {
    const t = buildCircular(makeFake(), scope, { count: 3, centered: true, axis: 'az' }, zRepo)
    // step = 360 / 5 = 72; indices 1, -1, 2, -2.
    expect(degrees(t)).toEqual([72, -72, 144, -144])
  })

  it('reads the angle as the neighbour increment when equal spacing is off', () => {
    const t = buildCircular(makeFake(), scope, { count: 3, angle: 30, equal_spacing: false, axis: 'az' }, zRepo)
    expect(degrees(t)).toEqual([30, 60])
  })

  it('emits one copy for count 2', () => {
    const t = buildCircular(makeFake(), scope, { count: 2, angle: 30, equal_spacing: false, axis: 'az' }, zRepo)
    expect(degrees(t)).toEqual([30])
  })

  it('rotates about the picked axis through its origin', () => {
    const t = buildCircular(makeFake(), scope, { count: 2, axis: 'az' }, zRepo)
    expect(rotations(t)[0].origin).toEqual([0, 0, 0])
    expect(rotations(t)[0].direction).toEqual([0, 0, 1])
  })

  it('resolves the axis from a picked planar face normal', () => {
    const faceRepo = dirRepo({}, { af: [0, 0, 2] })
    const t = buildCircular(makeFake(), scope, { count: 2, axis: 'af' }, faceRepo)
    expect(rotations(t)[0].direction).toEqual([0, 0, 1])
  })

  it('inverts the axis direction when invert_axis is set', () => {
    const t = buildCircular(makeFake(), scope, { count: 2, axis: 'az', invert_axis: true }, zRepo)
    expect(rotations(t)[0].direction).toEqual([0, 0, -1])
  })

  it('emits no copy for count 1, whatever the angle, and refuses count 0', () => {
    expect(buildCircular(makeFake(), scope, { count: 1, axis: 'az' }, zRepo)).toEqual([])
    expect(buildCircular(makeFake(), scope, { count: 1, angle: 30, equal_spacing: false, axis: 'az' }, zRepo)).toEqual([])
    for (const count of [0, -2]) {
      expect(() => buildCircular(makeFake(), scope, { count, axis: 'az' }, zRepo))
        .toThrow(/whole number of at least 1/)
    }
  })

  it('throws instead of silently truncating when count is fractional', () => {
    expect(() => buildCircular(makeFake(), scope, { count: 2.7, axis: 'az' }, zRepo))
      .toThrow(/whole number of at least 1/)
  })

  it('refuses an increment that lands a copy on the seed', () => {
    expect(() => buildCircular(makeFake(), scope, { count: 5, angle: 90, equal_spacing: false, axis: 'az' }, zRepo))
      .toThrow(/instance 4 lands on instance 0 \(step 90 deg\)/)
  })

  it('refuses an equal-spaced sweep past a full turn', () => {
    expect(() => buildCircular(makeFake(), scope, { count: 4, angle: 720, equal_spacing: true, axis: 'az' }, zRepo))
      .toThrow(/more than a full turn/)
  })

  it('refuses a zero sweep that stacks every copy on the source', () => {
    expect(() => buildCircular(makeFake(), scope, { count: 3, angle: 0, axis: 'az' }, zRepo))
      .toThrow(/lands on instance 0/)
  })

  it('refuses a negative angle and names the invert route', () => {
    expect(() => buildCircular(makeFake(), scope, { count: 4, angle: -30, axis: 'az' }, zRepo))
      .toThrow(/reverse the sense with invert_axis/)
  })

  it('throws when the angle is not finite', () => {
    expect(() => buildCircular(makeFake(), scope, { count: 4, angle: NaN, axis: 'az' }, zRepo))
      .toThrow(/angle must be a finite number/)
  })

  it('throws when the axis picker is empty', () => {
    expect(() => buildCircular(makeFake(), scope, { count: 2 }, repo)).toThrow(/axis is required/)
  })

  it('throws when the axis query does not resolve', () => {
    expect(() => buildCircular(makeFake(), scope, { count: 2, axis: 'dangling' }, repo)).toThrow(/did not resolve/)
  })

  it('resolves the axis from a picked circular edge (center + axis)', () => {
    const circleRepo = {
      query: (q: string) => {
        if (q === 'ce') return { center: [5, 0, 0], axis: [0, 1, 0], radius: 3, kind: 'circle' }
        return null
      },
      elements: new Map(),
    } as unknown as Repository
    const t = buildCircular(makeFake(), scope, { count: 2, axis: 'ce' }, circleRepo)
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
    const t = buildCircular(makeFake(), scope, { count: 2, axis: 'cf' }, cylRepo)
    expect(rotations(t)[0].origin).toEqual([10, 0, 0])
    expectCloseVec(rotations(t)[0].direction, [1, 0, 0])
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
    const t = buildCircular(makeFake(), scope, { count: 2, axis: '@sk/c1' }, sketchCircleRepo)
    // Centre [3, 0] lifted to [3, 0, 0] on XY plane; axis = normal [0, 0, 1].
    expect(rotations(t)[0].origin).toEqual([3, 0, 0])
    expectCloseVec(rotations(t)[0].direction, [0, 0, 1])
  })

  it('skips a circular edge that carries undefined start/end via truthy guard', () => {
    const circEdgeRepo = {
      query: (q: string) => {
        if (q === 'ce') return { start: undefined, end: undefined, center: [0, 0, 0], axis: [0, 0, 1], kind: 'circle' }
        return null
      },
      elements: new Map(),
    } as unknown as Repository
    const t = buildCircular(makeFake(), scope, { count: 2, axis: 'ce' }, circEdgeRepo)
    expect(rotations(t)[0].origin).toEqual([0, 0, 0])
    expectCloseVec(rotations(t)[0].direction, [0, 0, 1])
  })

  it('skips a straight edge that carries undefined center/axis via truthy guard', () => {
    const straightEdgeRepo = {
      query: (q: string) => {
        if (q === 'se') return { start: [0, 0, 0], end: [0, 0, 3], center: undefined, axis: undefined }
        return null
      },
      elements: new Map(),
    } as unknown as Repository
    const t = buildCircular(makeFake(), scope, { count: 2, axis: 'se' }, straightEdgeRepo)
    expectCloseVec(rotations(t)[0].direction, [0, 0, 1])
  })

  it('falls through to the face normal when a cylinderface has no axis field', () => {
    const badCylRepo = {
      query: (q: string) => {
        if (q === 'cf') return { type: 'cylinderface', centroid: [0, 0, 0], normal: [0, 0, 1] }
        return null
      },
      elements: new Map(),
    } as unknown as Repository
    const t = buildCircular(makeFake(), scope, { count: 2, axis: 'cf' }, badCylRepo)
    expectCloseVec(rotations(t)[0].direction, [0, 0, 1])
  })
})

// Both leaves resolve their source body before touching OCC, so the two
// diagnoses they can report are reachable with no kernel at all.
describe('pattern source body diagnosis', () => {
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
    for (const [solve, key] of [[solveLinear, 'linear_pattern'], [solveCircular, 'circular_pattern']] as const) {
      const feature = { id: 'ar1', [key]: { source_body: '@ex1' } }
      expect(() => solve(noOcc, scope, noTable, feature, noRepo, store())).toThrow(/ambiguous/)
      expect(() => solve(noOcc, scope, noTable, feature, noRepo, store())).not.toThrow(/not found/)
    }
  })

  it('still reports a ref that matches nothing as missing', () => {
    const feature = { id: 'ar1', linear_pattern: { source_body: '@nope' } }
    expect(() => solveLinear(noOcc, scope, noTable, feature, noRepo, store()))
      .toThrow(/source body '@nope' not found/)
  })
})

// A count of 1 no longer reaches a boolean at all: the source passes through
// untouched, with no warning, for either operation.
describe('count 1 through the leaf', () => {
  it.each(['add', 'new'])('leaves the source untouched for operation %s', (operation) => {
    const body = { ...bareBody('body_ex1', 'ex1'), shape: 1 as never }
    const table = { get: () => { throw new Error('count 1 must not touch a shape') } } as unknown as HandleTable
    const result = solveLinear(
      makeFake(), scope, table,
      { id: 'ar9', linear_pattern: { source_body: 'body_ex1', count: 1, pitch: 10, direction_query: 'qx', operation } },
      xyRepo, { body_ex1: body },
    ) as { status: string; body_ids: string[]; solver_warning?: string }
    expect(result.status).toBe('ok')
    expect(result.body_ids).toEqual(operation === 'new' ? [] : ['body_ex1'])
    expect(result.solver_warning).toBeUndefined()
  })
})

function expectCloseVec(actual: number[], expected: number[], tol = 1e-9): void {
  expect(actual).toHaveLength(expected.length)
  for (let i = 0; i < expected.length; i++) {
    expect(Math.abs(actual[i] - expected[i]), `${actual[i]} != ${expected[i]}`).toBeLessThanOrEqual(tol)
  }
}
