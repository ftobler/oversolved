import { describe, it, expect } from 'vitest'
import { measureOne, measurePair, isKernelAsk, type Readout } from '@/utils/measure/rules'
import { normalize, type Primitive, type Vec3 } from '@/utils/measure/primitives'

// Hand-built world primitives: the rules are pure, so every cell of the pair
// table is driven directly instead of through OCC or a sketch solve.

const v = (x: number, y: number, z = 0): Vec3 => [x, y, z]

const point = (p: Vec3): Primitive => ({ type: 'point', p })
const sphere = (center: Vec3, radius: number): Primitive => ({ type: 'sphere', center, radius })
const plane = (p: Vec3, normal: Vec3): Primitive => ({
  type: 'plane', point: p, normal: normalize(normal)!, bounded: true,
})
const circle = (center: Vec3, axis: Vec3, radius: number, sweep = Math.PI * 2): Primitive => ({
  type: 'circle', center, axis: normalize(axis)!, radius, sweep,
})
const ellipse = (center: Vec3, axis: Vec3, a: number, b: number): Primitive => ({
  type: 'ellipse', center, axis: normalize(axis)!, a, b,
})
const cylinder = (axisPoint: Vec3, axis: Vec3, radius: number): Primitive => ({
  type: 'cylinder', axisPoint, axis: normalize(axis)!, radius,
})
const cone = (axisPoint: Vec3, axis: Vec3, semiAngle?: number): Primitive => ({
  type: 'cone', axisPoint, axis: normalize(axis)!, semiAngle,
})
const torus = (center: Vec3, axis: Vec3, majorRadius?: number, minorRadius?: number): Primitive => ({
  type: 'torus', center, axis: normalize(axis)!, majorRadius, minorRadius,
})
const opaque = (what = 'spline'): Primitive => ({ type: 'opaque', what, ref: 'q' })
const solid = (): Primitive => ({ type: 'solid', bodyId: 'body_1' })

function line(p0: Vec3, p1: Vec3, bounded = true): Primitive {
  return { type: 'line', p0, p1, dir: normalize([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]])!, bounded }
}

const distanceReadout = (value: number, label = 'distance'): Readout => ({ kind: 'distance', value, label })
const angleReadout = (value: number): Readout => ({ kind: 'angle', value, label: 'angle' })

// Angle values are acos results, so two spellings of the same 45 degrees can
// differ in the last bit; compare the value with a tolerance and the rest
// exactly.
function expectReadout(result: unknown, expected: Readout): void {
  expect(result).not.toBeNull()
  const readout = result as Readout
  expect(readout.kind).toBe(expected.kind)
  expect(readout.label).toBe(expected.label)
  expect(readout.value).toBeCloseTo(expected.value, 9)
  expect(readout.extra?.length ?? 0).toBe(expected.extra?.length ?? 0)
  expected.extra?.forEach((extra, i) => expectReadout(readout.extra![i], extra))
}

describe('measurePair: the pair table, both pick orders', () => {
  interface Case {
    name: string
    a: Primitive
    b: Primitive
    expected: Readout
  }

  // One case per non-empty analytic cell. `expected` is what both (a, b) and
  // (b, a) must return: the table is unordered by construction.
  const cases: Case[] = [
    {
      name: 'point + point',
      a: point(v(0, 0, 0)), b: point(v(3, 4, 0)),
      expected: distanceReadout(5),
    },
    {
      name: 'point + line',
      a: point(v(1, 2, 0)), b: line(v(-4, 0, 0), v(4, 0, 0)),
      expected: distanceReadout(2),
    },
    {
      name: 'point + circle centre',
      a: point(v(0, 0, 0)), b: circle(v(3, 4, 0), v(0, 0, 1), 1),
      expected: distanceReadout(5, 'center distance'),
    },
    {
      name: 'point + plane',
      a: point(v(1, 2, 7)), b: plane(v(0, 0, 0), v(0, 0, 1)),
      expected: distanceReadout(7),
    },
    {
      name: 'point + cylinder axis',
      a: point(v(3, 4, 0)), b: cylinder(v(0, 0, 0), v(0, 0, 1), 2),
      expected: distanceReadout(5, 'axis distance'),
    },
    {
      name: 'parallel line + line',
      a: line(v(0, 0, 0), v(5, 0, 0)), b: line(v(0, 3, 0), v(5, 3, 0)),
      expected: distanceReadout(3),
    },
    {
      name: 'perpendicular line + line',
      a: line(v(0, 0, 0), v(5, 0, 0)), b: line(v(0, 0, 0), v(0, 5, 0)),
      expected: angleReadout(90),
    },
    {
      name: 'line + circle',
      a: line(v(-4, 0, 0), v(4, 0, 0)), b: circle(v(0, 3, 0), v(0, 0, 1), 1),
      expected: distanceReadout(3, 'center distance'),
    },
    {
      name: 'line parallel to plane',
      a: line(v(0, 0, 3), v(5, 0, 3)), b: plane(v(0, 0, 0), v(0, 0, 1)),
      expected: distanceReadout(3),
    },
    {
      name: 'line oblique to plane',
      a: line(v(0, 0, 0), v(1, 0, 1)), b: plane(v(0, 0, 0), v(0, 0, 1)),
      expected: angleReadout(45),
    },
    {
      name: 'line parallel to cylinder axis',
      a: line(v(0, 3, 0), v(0, 3, 5)), b: cylinder(v(0, 0, 0), v(0, 0, 1), 2),
      expected: distanceReadout(3, 'axis distance'),
    },
    {
      name: 'line perpendicular to cylinder axis',
      a: line(v(0, 0, 0), v(5, 0, 0)), b: cylinder(v(0, 0, 0), v(0, 0, 1), 2),
      expected: angleReadout(90),
    },
    {
      name: 'circle + circle',
      a: circle(v(0, 0, 0), v(0, 0, 1), 1), b: circle(v(3, 4, 0), v(0, 0, 1), 2),
      expected: distanceReadout(5, 'center distance'),
    },
    {
      name: 'circle parallel to plane',
      a: circle(v(0, 0, 3), v(0, 0, 1), 1), b: plane(v(0, 0, 0), v(0, 0, 1)),
      expected: distanceReadout(3),
    },
    {
      name: 'circle perpendicular to plane',
      a: circle(v(0, 0, 0), v(1, 0, 0), 1), b: plane(v(0, 0, 0), v(0, 0, 1)),
      expected: angleReadout(90),
    },
    {
      name: 'circle parallel to cylinder axis',
      a: circle(v(3, 0, 0), v(0, 0, 1), 1), b: cylinder(v(0, 0, 0), v(0, 0, 1), 2),
      expected: distanceReadout(3, 'axis distance'),
    },
    {
      name: 'circle oblique to cylinder axis',
      a: circle(v(0, 0, 0), v(1, 0, 1), 1), b: cylinder(v(0, 0, 0), v(0, 0, 1), 2),
      expected: angleReadout(45),
    },
    {
      name: 'parallel plane + plane',
      a: plane(v(0, 0, 0), v(0, 0, 1)), b: plane(v(0, 0, 5), v(0, 0, 1)),
      expected: distanceReadout(5),
    },
    {
      name: 'perpendicular plane + plane',
      a: plane(v(0, 0, 0), v(0, 0, 1)), b: plane(v(0, 0, 0), v(1, 0, 0)),
      expected: angleReadout(90),
    },
    {
      name: 'plane + cylinder axis lying in it',
      a: plane(v(0, 0, 0), v(0, 0, 1)), b: cylinder(v(0, 0, 3), v(1, 0, 0), 2),
      expected: distanceReadout(3, 'axis distance'),
    },
    {
      name: 'plane + cylinder axis oblique to it',
      a: plane(v(0, 0, 0), v(0, 0, 1)), b: cylinder(v(0, 0, 0), v(1, 0, 1), 2),
      expected: angleReadout(45),
    },
    {
      name: 'parallel cylinder + cylinder axes',
      a: cylinder(v(0, 0, 0), v(0, 0, 1), 2), b: cylinder(v(3, 0, 0), v(0, 0, 1), 2),
      expected: distanceReadout(3, 'axis distance'),
    },
    {
      name: 'perpendicular cylinder + cylinder axes',
      a: cylinder(v(0, 0, 0), v(0, 0, 1), 2), b: cylinder(v(0, 0, 0), v(1, 0, 0), 2),
      expected: angleReadout(90),
    },
    {
      name: 'ellipse pairs through its centre like a circle',
      a: ellipse(v(0, 0, 0), v(0, 0, 1), 4, 2), b: point(v(3, 4, 0)),
      expected: distanceReadout(5, 'center distance'),
    },
    {
      name: 'sphere pairs as its centre',
      a: sphere(v(0, 0, 0), 2), b: plane(v(0, 0, 0), v(1, 0, 0)),
      expected: distanceReadout(0),
    },
    {
      name: 'cone pairs through its axis',
      a: cone(v(0, 0, 0), v(1, 0, 0)), b: plane(v(0, 0, 0), v(0, 0, 1)),
      expected: distanceReadout(0, 'axis distance'),
    },
    {
      name: 'torus pairs through its axis',
      a: torus(v(0, 0, 0), v(1, 0, 0)), b: cylinder(v(0, 0, 0), v(1, 0, 0), 2),
      expected: distanceReadout(0, 'axis distance'),
    },
  ]

  it.each(cases)('$name reads the same in either pick order', ({ a, b, expected }) => {
    expectReadout(measurePair(a, b), expected)
    expectReadout(measurePair(b, a), expected)
  })
})

describe('measurePair: versions of a branching cell', () => {
  it('two parallel lines report their perpendicular distance, not an angle', () => {
    expectReadout(measurePair(line(v(0, 0, 0), v(5, 0, 0)), line(v(0, 3, 0), v(5, 3, 0))),
      { kind: 'distance', value: 3, label: 'distance' })
  })

  it('two perpendicular lines report 90 degrees', () => {
    expectReadout(measurePair(line(v(0, 0, 0), v(5, 0, 0)), line(v(0, 0, 0), v(0, 5, 0))),
      { kind: 'angle', value: 90, label: 'angle' })
  })

  it('two oblique lines report the acute angle', () => {
    expectReadout(measurePair(line(v(0, 0, 0), v(5, 0, 0)), line(v(0, 0, 0), v(5, 5, 0))),
      { kind: 'angle', value: 45, label: 'angle' })
  })

  it('pins the parallel threshold: 1e-5 rad off still reads parallel', () => {
    const theta = 1e-5  // < PARALLEL_ANGLE_EPS_RAD (1e-4)
    const tilted = line(v(0, 3, 0), v(Math.cos(theta), 3 + Math.sin(theta), 0))
    expectReadout(measurePair(line(v(0, 0, 0), v(1, 0, 0)), tilted), distanceReadout(3))
  })

  it('pins the parallel threshold: 1e-3 rad off reads as an angle', () => {
    const theta = 1e-3  // > PARALLEL_ANGLE_EPS_RAD (1e-4)
    const tilted = line(v(0, 3, 0), v(Math.cos(theta), 3 + Math.sin(theta), 0))
    expectReadout(measurePair(line(v(0, 0, 0), v(1, 0, 0)), tilted),
      { kind: 'angle', value: (theta * 180) / Math.PI, label: 'angle' })
  })

  it('a line along the plane normal makes a 90 degree angle with the plane', () => {
    expectReadout(measurePair(line(v(0, 0, 0), v(0, 0, 5)), plane(v(0, 0, 0), v(0, 0, 1))),
      { kind: 'angle', value: 90, label: 'angle' })
  })

  it('an oblique line makes 45 degrees with the plane', () => {
    expectReadout(measurePair(line(v(0, 0, 0), v(1, 0, 1)), plane(v(0, 0, 0), v(0, 0, 1))),
      { kind: 'angle', value: 45, label: 'angle' })
  })

  it('a circle oblique to a plane reads the angle between the planes', () => {
    expectReadout(measurePair(circle(v(0, 0, 0), v(1, 0, 1), 1), plane(v(0, 0, 0), v(0, 0, 1))),
      { kind: 'angle', value: 45, label: 'angle' })
  })

  it('two oblique planes read the acute dihedral angle', () => {
    expectReadout(measurePair(plane(v(0, 0, 0), v(0, 0, 1)), plane(v(0, 0, 0), v(1, 0, 1))),
      { kind: 'angle', value: 45, label: 'angle' })
  })
})

describe('measurePair: skew line pairs (D4)', () => {
  // A runs along x at y=0, z=0; B is perpendicular, at z=4, from y=3 to y=7.
  // The segments never meet, so the angle alone understates the pair: the
  // closed-form segment minimum rides along as a second readout.
  const a = line(v(0, 0, 0), v(10, 0, 0))
  const b = line(v(5, 3, 4), v(5, 7, 4))

  it('reports the angle plus the segment-to-segment minimum distance', () => {
    expectReadout(measurePair(a, b), {
      kind: 'angle',
      value: 90,
      label: 'angle',
      extra: [{ kind: 'distance', value: 5, label: 'distance' }],
    })
  })

  it('adds no distance when the two lines are coplanar and simply cross', () => {
    // Same directions, but B lies in the z=0 plane through A: their minimum is
    // the crossing point (0), which is not a useful second readout.
    const crossing = line(v(5, -5, 0), v(5, 5, 0))
    expectReadout(measurePair(a, crossing), { kind: 'angle', value: 90, label: 'angle' })
  })

  it('adds no distance when a line has no known extent', () => {
    // An assembly anchor carries a direction and one point, not endpoints, so a
    // made-up segment would invent a gap.
    const unbounded = line(v(5, 3, 4), v(5, 7, 4), false)
    expectReadout(measurePair(a, unbounded), { kind: 'angle', value: 90, label: 'angle' })
  })
})

describe('measureOne: the singles table', () => {
  it('a line reads its segment length', () => {
    expectReadout(measureOne(line(v(0, 0, 0), v(3, 4, 0))), { kind: 'length', value: 5, label: 'length' })
  })

  it('an arc reads its radius and sweep', () => {
    expectReadout(measureOne(circle(v(0, 0, 0), v(0, 0, 1), 3, Math.PI / 2)), {
      kind: 'radius',
      value: 3,
      label: 'radius',
      extra: [{ kind: 'angle', value: 90, label: 'angle' }],
    })
  })

  it('a full circle reads its diameter, not a 360 degree radius', () => {
    expectReadout(measureOne(circle(v(0, 0, 0), v(0, 0, 1), 4)), {
      kind: 'diameter', value: 8, label: 'diameter',
    })
  })

  it('a cylinder reads its diameter', () => {
    expectReadout(measureOne(cylinder(v(0, 0, 0), v(0, 0, 1), 4)), {
      kind: 'diameter', value: 8, label: 'diameter',
    })
  })

  it('a sphere reads its diameter', () => {
    expectReadout(measureOne(sphere(v(0, 0, 0), 7)), { kind: 'diameter', value: 14, label: 'diameter' })
  })

  it('an ellipse reads both semi-axes', () => {
    expectReadout(measureOne(ellipse(v(0, 0, 0), v(0, 0, 1), 4, 2)), {
      kind: 'radius',
      value: 4,
      label: 'major radius',
      extra: [{ kind: 'radius', value: 2, label: 'minor radius' }],
    })
  })

  it('a cone reads nothing until the solve reports its half angle', () => {
    expect(measureOne(cone(v(0, 0, 0), v(0, 0, 1)))).toBeNull()
  })

  it('a cone reads its half angle when the solve reports it', () => {
    expectReadout(measureOne(cone(v(0, 0, 0), v(0, 0, 1), Math.PI / 6)),
      { kind: 'angle', value: 30, label: 'angle' })
  })

  it('a torus reads nothing until the solve reports its radii', () => {
    expect(measureOne(torus(v(0, 0, 0), v(0, 0, 1)))).toBeNull()
  })

  it('a torus reads its major and minor radius when the solve reports them', () => {
    expectReadout(measureOne(torus(v(0, 0, 0), v(0, 0, 1), 10, 3)), {
      kind: 'radius',
      value: 10,
      label: 'major radius',
      extra: [{ kind: 'radius', value: 3, label: 'minor radius' }],
    })
  })

  it('an opaque edge asks the kernel for its length', () => {
    const result = measureOne(opaque())
    expect(isKernelAsk(result)).toBe(true)
    expect(result).toEqual({ kernel: 'length' })
  })

  it('a flat face, a vertex, a datum plane and a whole body read nothing', () => {
    expect(measureOne(plane(v(0, 0, 0), v(0, 0, 1)))).toBeNull()
    expect(measureOne(point(v(1, 2, 3)))).toBeNull()
    expect(measureOne(solid())).toBeNull()
  })
})

describe('measurePair: kernel cells', () => {
  it('one opaque pick asks the kernel for a distance', () => {
    expect(measurePair(opaque(), line(v(0, 0, 0), v(1, 0, 0)))).toEqual({ kernel: 'distance' })
  })

  it('two opaque picks ask the kernel for a clearance', () => {
    expect(measurePair(opaque('spline'), opaque('freeform face'))).toEqual({ kernel: 'clearance' })
  })

  it('two whole-body picks ask the kernel for a clearance', () => {
    expect(measurePair(solid(), solid())).toEqual({ kernel: 'clearance' })
  })

  it('a whole body against an edge asks the kernel for a distance', () => {
    expect(measurePair(solid(), line(v(0, 0, 0), v(1, 0, 0)))).toEqual({ kernel: 'distance' })
  })
})
