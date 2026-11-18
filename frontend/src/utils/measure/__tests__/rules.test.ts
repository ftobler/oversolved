import { describe, it, expect } from 'vitest'
import { measureOne, measurePair, isKernelAsk, KERNEL_PAIR_RULES, PAIR_RULES, type Readout } from '@/utils/measure/rules'
import { normalize, type Primitive, type Vec3 } from '@/utils/measure/primitives'

// Hand-built world primitives: the rules are pure, so every cell of the pair
// table is driven directly instead of through OCC or a sketch solve.

const v = (x: number, y: number, z = 0): Vec3 => [x, y, z]

const point = (p: Vec3): Primitive => ({ type: 'point', p })
const sphere = (center: Vec3, radius: number): Primitive => ({ type: 'sphere', center, radius })
const plane = (p: Vec3, normal: Vec3): Primitive => ({
  type: 'plane', point: p, normal: normalize(normal)!, bounded: true,
})
const datumPlane = (p: Vec3, normal: Vec3): Primitive => ({
  type: 'plane', point: p, normal: normalize(normal)!, bounded: false,
})
const circle = (center: Vec3, axis: Vec3, radius: number, sweep = Math.PI * 2): Primitive => ({
  type: 'circle', center, axis: normalize(axis)!, radius, sweep,
})
const ellipse = (center: Vec3, axis: Vec3, a: number, b: number): Primitive => ({
  type: 'ellipse', center, axis: normalize(axis)!, a, b,
})
const cylinder = (axisPoint: Vec3, axis: Vec3, radius?: number, length?: number): Primitive => ({
  type: 'cylinder', axisPoint, axis: normalize(axis)!, ...(radius !== undefined && { radius }), ...(length !== undefined && { length }),
})
const cone = (axisPoint: Vec3, axis: Vec3, semiAngle?: number): Primitive => ({
  type: 'cone', axisPoint, axis: normalize(axis)!, semiAngle,
})
const torus = (center: Vec3, axis: Vec3, majorRadius?: number, minorRadius?: number): Primitive => ({
  type: 'torus', center, axis: normalize(axis)!, majorRadius, minorRadius,
})
const opaque = (what = 'spline'): Primitive => ({ type: 'opaque', what, ref: 'q' })
const solid = (): Primitive => ({ type: 'solid', partId: 'body_1' })

function line(p0: Vec3, p1: Vec3, bounded = true): Primitive {
  return { type: 'line', p0, p1, dir: normalize([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]])!, bounded }
}

const distanceReadout = (value: number, label = 'distance'): Readout => ({ kind: 'distance', value, label })
const angleReadout = (value: number): Readout => ({
  kind: 'angle',
  value,
  label: 'angle',
  extra: [{ kind: 'angle', value: 180 - value, label: 'supplement' }],
})
const deltas = (dx: number, dy: number, dz: number): Readout[] => [
  distanceReadout(dx, 'dx'),
  distanceReadout(dy, 'dy'),
  distanceReadout(dz, 'dz'),
]

// Angle values are acos results, so two spellings of the same 45 degrees can
// differ in the last bit; compare the value with a tolerance and the rest
// exactly.
function expectReadout(result: unknown, expected: Readout): void {
  expect(result).not.toBeNull()
  const readout = result as Readout
  expect(readout.kind).toBe(expected.kind)
  expect(readout.label).toBe(expected.label)
  expect(readout.value).toBeCloseTo(expected.value, 9)
  expect(readout.note).toBe(expected.note)
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
      expected: { ...distanceReadout(5), extra: deltas(3, 4, 0) },
    },
    {
      name: 'point + line',
      a: point(v(1, 2, 0)), b: line(v(-4, 0, 0), v(4, 0, 0)),
      expected: distanceReadout(2),
    },
    {
      name: 'point + circle centre',
      a: point(v(0, 0, 0)), b: circle(v(3, 4, 0), v(0, 0, 1), 1),
      expected: { ...distanceReadout(5, 'center distance'), extra: deltas(3, 4, 0) },
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
      expected: {
        ...distanceReadout(3),
        extra: [distanceReadout(0, 'alignment offset')],
      },
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
      expected: {
        ...distanceReadout(5, 'pitch'),
        extra: [
          distanceReadout(5, 'center distance'),
          distanceReadout(2, 'min gap'),
          distanceReadout(8, 'max span'),
          ...deltas(3, 4, 0),
        ],
      },
    },
    {
      name: 'circle parallel to plane',
      a: circle(v(0, 0, 3), v(0, 0, 1), 1), b: plane(v(0, 0, 0), v(0, 0, 1)),
      expected: distanceReadout(3),
    },
    {
      name: 'circle perpendicular to plane',
      a: circle(v(0, 0, 0), v(1, 0, 0), 1), b: plane(v(0, 0, 0), v(0, 0, 1)),
      expected: distanceReadout(0),
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
      expected: {
        ...distanceReadout(3, 'axis distance'),
        extra: [distanceReadout(-1, 'overlap'), distanceReadout(7, 'max span')],
      },
    },
    {
      name: 'perpendicular cylinder + cylinder axes',
      a: cylinder(v(0, 0, 0), v(0, 0, 1), 2), b: cylinder(v(0, 0, 0), v(1, 0, 0), 2),
      expected: angleReadout(90),
    },
    {
      name: 'ellipse pairs through its centre like a circle',
      a: ellipse(v(0, 0, 0), v(0, 0, 1), 4, 2), b: point(v(3, 4, 0)),
      expected: { ...distanceReadout(5, 'center distance'), extra: deltas(3, 4, 0) },
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

describe('measurePair: circle pairs read the layout, not the slant', () => {
  it('two hole rims at different depths read the pitch, their centre distance and the axial offset', () => {
    // Centres 30 apart in plan and 5 deep of one another: the 3D centre
    // distance (sqrt(925)) is the slant, the pitch is what a bolt pattern cares
    // about.
    const readout = measurePair(
      circle(v(0, 0, 0), v(0, 0, 1), 5),
      circle(v(30, 0, 5), v(0, 0, 1), 5),
    ) as Readout
    expect(readout.label).toBe('pitch')
    expect(readout.value).toBeCloseTo(30, 9)
    const labels = (readout.extra ?? []).map((extra) => extra.label)
    expect(labels).toEqual(['center distance', 'axial offset', 'min gap', 'max span', 'dx', 'dy', 'dz'])
    expect(readout.extra![0].value).toBeCloseTo(Math.sqrt(925), 9)
    expect(readout.extra![1].value).toBeCloseTo(5, 9)
    expect(readout.extra![2].value).toBeCloseTo(20, 9)
    expect(readout.extra![3].value).toBeCloseTo(40, 9)
    expect(readout.extra!.slice(4).map((extra) => extra.value)).toEqual([30, 0, 5])
  })

  it('coaxial rims read the axial distance and the radial gap between the circles', () => {
    expectReadout(
      measurePair(circle(v(0, 0, 0), v(0, 0, 1), 5), circle(v(0, 0, 4), v(0, 0, 1), 10)),
      {
        ...distanceReadout(4, 'axial distance'),
        extra: [distanceReadout(5, 'radial gap')],
      },
    )
  })

  it('two rims 30 apart read min gap 20 and max span 40, while crossing rims read an overlap', () => {
    const apart = measurePair(circle(v(0, 0, 0), v(0, 0, 1), 5), circle(v(30, 0, 0), v(0, 0, 1), 5)) as Readout
    expect(apart.extra!.find((extra) => extra.label === 'min gap')!.value).toBeCloseTo(20, 9)
    expect(apart.extra!.find((extra) => extra.label === 'max span')!.value).toBeCloseTo(40, 9)

    const crossing = measurePair(
      circle(v(0, 0, 0), v(0, 0, 1), 20),
      circle(v(30, 0, 0), v(0, 0, 1), 20),
    ) as Readout
    const overlap = crossing.extra!.find((extra) => extra.label === 'overlap')!
    expect(overlap.kind).toBe('distance')
    expect(overlap.value).toBeCloseTo(-10, 9)
    expect(crossing.extra!.find((extra) => extra.label === 'max span')!.value).toBeCloseTo(70, 9)
  })

  it('a side hole rim against the wall it faces reads centre to face, not a 90 degree angle', () => {
    // The rim's axis lies along the wall (perpendicular to the wall normal), so
    // the useful number is the centre's distance to the face, which is the
    // depth of the hole's mouth from that wall.
    expectReadout(
      measurePair(circle(v(0, 7, 0), v(1, 0, 0), 2), plane(v(0, 0, 0), v(0, 1, 0))),
      distanceReadout(7),
    )
  })
})

describe('measurePair: versions of a branching cell', () => {
  it('two parallel lines report their perpendicular distance, not an angle', () => {
    expectReadout(measurePair(line(v(0, 0, 0), v(5, 0, 0)), line(v(0, 3, 0), v(5, 3, 0))),
      {
        kind: 'distance',
        value: 3,
        label: 'distance',
        extra: [{ kind: 'distance', value: 0, label: 'alignment offset' }],
      })
  })

  it('parallel edges slid along each other report the alignment offset', () => {
    expectReadout(measurePair(line(v(0, 0, 0), v(5, 0, 0)), line(v(12, 3, 0), v(17, 3, 0))),
      {
        kind: 'distance',
        value: 3,
        label: 'distance',
        extra: [{ kind: 'distance', value: 12, label: 'alignment offset' }],
      })
  })

  it('two perpendicular lines report 90 degrees', () => {
    expectReadout(measurePair(line(v(0, 0, 0), v(5, 0, 0)), line(v(0, 0, 0), v(0, 5, 0))),
      angleReadout(90))
  })

  it('two oblique lines report the acute angle', () => {
    expectReadout(measurePair(line(v(0, 0, 0), v(5, 0, 0)), line(v(0, 0, 0), v(5, 5, 0))),
      angleReadout(45))
  })

  it('an angle carries its supplement', () => {
    const theta = 30 * (Math.PI / 180)
    expectReadout(measurePair(
      line(v(0, 0, 0), v(5, 0, 0)),
      line(v(0, 0, 0), v(Math.cos(theta) * 5, Math.sin(theta) * 5, 0)),
    ), {
      kind: 'angle',
      value: 30,
      label: 'angle',
      extra: [{ kind: 'angle', value: 150, label: 'supplement' }],
    })
  })

  it('pins the parallel threshold: 1e-5 rad off still reads parallel', () => {
    const theta = 1e-5  // < PARALLEL_ANGLE_EPS_RAD (1e-4)
    const tilted = line(v(0, 3, 0), v(Math.cos(theta), 3 + Math.sin(theta), 0))
    expectReadout(measurePair(line(v(0, 0, 0), v(1, 0, 0)), tilted), {
      kind: 'distance',
      value: 3,
      label: 'distance',
      extra: [{ kind: 'distance', value: 0, label: 'alignment offset' }],
    })
  })

  it('pins the parallel threshold: 1e-3 rad off reads as an angle', () => {
    const theta = 1e-3  // > PARALLEL_ANGLE_EPS_RAD (1e-4)
    const tilted = line(v(0, 3, 0), v(Math.cos(theta), 3 + Math.sin(theta), 0))
    expectReadout(measurePair(line(v(0, 0, 0), v(1, 0, 0)), tilted),
      angleReadout((theta * 180) / Math.PI))
  })

  it('a line along the plane normal makes a 90 degree angle with the plane', () => {
    expectReadout(measurePair(line(v(0, 0, 0), v(0, 0, 5)), plane(v(0, 0, 0), v(0, 0, 1))),
      angleReadout(90))
  })

  it('an oblique line makes 45 degrees with the plane', () => {
    expectReadout(measurePair(line(v(0, 0, 0), v(1, 0, 1)), plane(v(0, 0, 0), v(0, 0, 1))),
      angleReadout(45))
  })

  it('a circle oblique to a plane reads the angle between the planes', () => {
    expectReadout(measurePair(circle(v(0, 0, 0), v(1, 0, 1), 1), plane(v(0, 0, 0), v(0, 0, 1))),
      angleReadout(45))
  })

  it('two oblique planes read the acute dihedral angle', () => {
    expectReadout(measurePair(plane(v(0, 0, 0), v(0, 0, 1)), plane(v(0, 0, 0), v(1, 0, 1))),
      angleReadout(45))
  })
})

describe('measurePair: pairs the kernel must finish', () => {
  it('two collinear bounded edges ask for the edge gap instead of reading 0', () => {
    // The infinite lines coincide, so the analytic answer is 0 whether the
    // edges touch or sit a hole's width apart; OCCT states the gap.
    expect(measurePair(line(v(0, 0, 0), v(5, 0, 0)), line(v(20, 0, 0), v(30, 0, 0))))
      .toEqual({ kernel: 'distance' })
  })

  it('two coplanar bounded faces ask for the face gap instead of reading 0', () => {
    expect(measurePair(plane(v(0, 0, 0), v(0, 0, 1)), plane(v(5, 0, 0), v(0, 0, 1))))
      .toEqual({ kernel: 'distance' })
  })

  it('a datum plane against a coplanar face reads 0, since a datum has no shape to measure', () => {
    expectReadout(measurePair(datumPlane(v(0, 0, 0), v(0, 0, 1)), plane(v(5, 0, 0), v(0, 0, 1))),
      distanceReadout(0))
  })

  it('unbounded lines (an assembly anchor) keep the analytic 0 rather than asking a kernel they have no shape for', () => {
    expectReadout(measurePair(line(v(0, 0, 0), v(1, 0, 0), false), line(v(20, 0, 0), v(21, 0, 0), false)),
      distanceReadout(0))
  })
})

describe('measurePair: skew line pairs (D4)', () => {
  // A runs along x at y=0, z=0; B is perpendicular, at z=4, from y=3 to y=7.
  // The segments never meet, so the angle alone understates the pair: the
  // closed-form segment minimum rides along as a second readout.
  const a = line(v(0, 0, 0), v(10, 0, 0))
  const b = line(v(5, 3, 4), v(5, 7, 4))

  it('reports the angle, its supplement and the segment-to-segment minimum distance', () => {
    expectReadout(measurePair(a, b), {
      kind: 'angle',
      value: 90,
      label: 'angle',
      extra: [
        { kind: 'angle', value: 90, label: 'supplement' },
        { kind: 'distance', value: 5, label: 'distance' },
      ],
    })
  })

  it('adds no distance when the two lines are coplanar and simply cross', () => {
    // Same directions, but B lies in the z=0 plane through A: their minimum is
    // the crossing point (0), which is not a useful second readout.
    const crossing = line(v(5, -5, 0), v(5, 5, 0))
    expectReadout(measurePair(a, crossing), angleReadout(90))
  })

  it('adds no distance when a line has no known extent', () => {
    // An assembly anchor carries a direction and one point, not endpoints, so a
    // made-up segment would invent a gap.
    const unbounded = line(v(5, 3, 4), v(5, 7, 4), false)
    expectReadout(measurePair(a, unbounded), angleReadout(90))
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

  it('a cylinder reads its diameter and, when the face states one, its axial length', () => {
    expectReadout(measureOne(cylinder(v(0, 0, 0), v(0, 0, 1), 4)), {
      kind: 'diameter', value: 8, label: 'diameter',
    })
    expectReadout(measureOne(cylinder(v(0, 0, 0), v(0, 0, 1), 4, 12)), {
      kind: 'diameter',
      value: 8,
      label: 'diameter',
      extra: [{ kind: 'length', value: 12, label: 'length' }],
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

  it('a bounded flat face asks the kernel for its area and a body for its volume', () => {
    expect(measureOne(plane(v(0, 0, 0), v(0, 0, 1)))).toEqual({ kernel: 'area' })
    expect(measureOne(solid())).toEqual({ kernel: 'volume' })
  })

  it('a vertex and a datum plane still read nothing', () => {
    expect(measureOne(point(v(1, 2, 3)))).toBeNull()
    expect(measureOne(datumPlane(v(0, 0, 0), v(0, 0, 1)))).toBeNull()
  })
})

describe('measurePair: point pairs state their delta legs', () => {
  it('the three legs square back to the distance', () => {
    const readout = measurePair(point(v(0, 0, 0)), point(v(3, 4, 12))) as Readout
    const legs = readout.extra!.map((extra) => extra.value)
    expect(Math.hypot(legs[0], legs[1], legs[2])).toBeCloseTo(readout.value, 9)
    expect(legs).toEqual([3, 4, 12])
  })

  it('the legs are order independent', () => {
    expectReadout(measurePair(point(v(3, 4, 0)), point(v(0, 0, 0))), {
      ...distanceReadout(5),
      extra: deltas(3, 4, 0),
    })
  })
})

describe('measurePair: the foot of a point-line distance', () => {
  it('marks a foot beyond the edge as on its extension', () => {
    // The point is past the edge's far endpoint but its perpendicular foot on
    // the infinite line is not on the segment.
    expectReadout(measurePair(point(v(10, 2, 0)), line(v(0, 0, 0), v(5, 0, 0))), {
      kind: 'distance',
      value: 2,
      label: 'distance',
      note: 'on extension',
    })
  })

  it('states no qualifier when the foot lies on the edge', () => {
    expectReadout(measurePair(point(v(3, 2, 0)), line(v(0, 0, 0), v(5, 0, 0))), distanceReadout(2))
  })

  it('states no qualifier for an unbounded line, which has no extension', () => {
    expectReadout(measurePair(point(v(10, 2, 0)), line(v(0, 0, 0), v(1, 0, 0), false)), distanceReadout(2))
  })
})

describe('measurePair: cursor independence', () => {
  // The measurement core takes no pick point: it must state the element's own
  // geometry whatever the cursor did. The guard pins that a stray pick field on
  // a primitive changes nothing, so a future cursor rule cannot slip in here.
  it('ignores a cursor or pick point carried on a primitive', () => {
    const base = circle(v(0, 0, 0), v(0, 0, 1), 5)
    const picked = { ...base, cursor: v(99, 99, 99), pickPoint: v(1, 1, 1) } as unknown as Primitive
    const other = circle(v(30, 0, 5), v(0, 0, 1), 5)
    expect(measurePair(picked, other)).toEqual(measurePair(base, other))
  })
})

describe('measurePair: kernel cells', () => {
  it('one opaque pick asks the kernel for a distance', () => {
    expect(measurePair(opaque(), line(v(0, 0, 0), v(1, 0, 0)))).toEqual({ kernel: 'distance' })
  })

  it('two opaque picks ask for the distance between their boundaries, not a clearance', () => {
    // A clearance is two whole bodies: it runs the overlap probe and reads 0 for
    // a containment. Two spline edges (or two freeform faces) are a boundary
    // distance, so the overlap probe must not run on them.
    expect(measurePair(opaque('spline'), opaque('freeform face'))).toEqual({ kernel: 'distance' })
  })

  it('two whole-body picks ask the kernel for a clearance', () => {
    expect(measurePair(solid(), solid())).toEqual({ kernel: 'clearance' })
  })

  it('a whole body against an edge asks the kernel for a distance', () => {
    expect(measurePair(solid(), line(v(0, 0, 0), v(1, 0, 0)))).toEqual({ kernel: 'distance' })
  })
})

describe('the kernel table', () => {
  // One representative per class the table dispatches on.
  const reps: Record<string, Primitive> = {
    point: point(v(0, 0, 0)),
    line: line(v(0, 0, 0), v(1, 0, 0)),
    circle: circle(v(0, 0, 0), v(0, 0, 1), 1),
    plane: plane(v(0, 0, 0), v(0, 0, 1)),
    cylinder: cylinder(v(0, 0, 0), v(0, 0, 1), 1),
    opaque: opaque(),
    body: solid(),
  }
  const key = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const kernelCells = new Map(KERNEL_PAIR_RULES.map((row) => [key(row.a, row.b), row.op]))
  const analyticCells = new Set(PAIR_RULES.map((row) => key(row.a, row.b)))

  // A plane or a line paired with ITSELF is the coplanar/collinear case, which
  // the analytic cell hands to the kernel by condition rather than by class.
  const conditional = (a: string, b: string): boolean => a === b && (a === 'plane' || a === 'line')

  it('lists every cell the dispatch function sends to the kernel, and no cell twice', () => {
    expect(kernelCells.size).toBe(KERNEL_PAIR_RULES.length)
    for (const [a, pa] of Object.entries(reps)) {
      for (const [b, pb] of Object.entries(reps)) {
        const result = measurePair(pa, pb)
        const op = kernelCells.get(key(a, b))
        const expectsKernel = op !== undefined || conditional(a, b)
        expect({ cell: key(a, b), kernel: isKernelAsk(result) }).toEqual({ cell: key(a, b), kernel: expectsKernel })
        if (op !== undefined) expect(result).toEqual({ kernel: op })
      }
    }
  })

  it('never lists a cell as both analytic and kernel', () => {
    const both = [...kernelCells.keys()].filter((cell) => analyticCells.has(cell))
    expect(both).toEqual([])
  })
})
