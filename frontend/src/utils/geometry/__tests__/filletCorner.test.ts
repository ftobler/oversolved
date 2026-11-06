// The pure corner math: tangent distance, centre, sweep and the material probe
// that decides whether a corner is convex or concave. No document, no kernel.
// The expectations are analytic numbers from a 90/30/150 degree corner and from
// an L strip with a 1 mm wall, the same shape the din_rail real-kernel test
// extrudes.

import { describe, it, expect } from 'vitest'
import {
  buildFilletCornerMap,
  planFilletGeometry,
  type FilletCorner,
  type FilletCornerSide,
} from '@/utils/geometry/filletCorner'

type Pt = [number, number]

const line = (id: string, x1: number, y1: number, x2: number, y2: number): FilletCornerSide =>
  ({ id, kind: 'line', params: [x1, y1, x2, y2] })

function cornerPlan(entities: FilletCornerSide[], corners: FilletCorner[], radius: number) {
  const plan = planFilletGeometry(entities, corners, radius)
  if ('reason' in plan) throw new Error(plan.reason)
  return plan.corners
}

const expectPoint = (actual: Pt, expected: Pt, digits = 6): void => {
  expect(actual[0]).toBeCloseTo(expected[0], digits)
  expect(actual[1]).toBeCloseTo(expected[1], digits)
}

// A corner at the origin with one side along +x and the other at `angleDeg`
// from it; both sides run away from the corner so the named endpoints meet.
function wedge(angleDeg: number, length = 40): [FilletCornerSide[], FilletCorner] {
  const rad = (angleDeg * Math.PI) / 180
  const entities = [
    line('a', length, 0, 0, 0),
    line('b', 0, 0, length * Math.cos(rad), length * Math.sin(rad)),
  ]
  return [entities, { a: 'a', aVertex: 'end', b: 'b', bVertex: 'start' }]
}

describe('planFilletGeometry tangent math', () => {
  it('rounds a 90 degree corner at r5 with a 90 degree sweep', () => {
    const [entities, corner] = wedge(90)
    const [geo] = cornerPlan(entities, [corner], 5)
    expect(geo.tangentDistance).toBe(5)
    expect(geo.sweepDeg).toBe(90)
    expect(geo.radius).toBe(5)
    expectPoint(geo.center, [5, 5])
    expectPoint(geo.ta, [5, 0])
    expectPoint(geo.tb, [0, 5])
    expect(Math.hypot(geo.center[0], geo.center[1])).toBeCloseTo(7.0710678118654755, 12)
    // The stored pair is a CCW sweep of the expected span, and a0/a1 land on
    // the two tangent points.
    const [cx, cy, r, a0, a1] = geo.arc
    expect([cx, cy, r]).toEqual([5, 5, 5])
    expect(a1 - a0).toBeCloseTo(90, 9)
  })

  it('rounds a 30 degree corner at r5 with a 150 degree sweep', () => {
    const [entities, corner] = wedge(30)
    const [geo] = cornerPlan(entities, [corner], 5)
    expect(geo.tangentDistance).toBeCloseTo(18.660254, 6)
    expect(geo.sweepDeg).toBeCloseTo(150, 6)
    expectPoint(geo.center, [18.660254, 5], 6)
    expect(geo.arc[4] - geo.arc[3]).toBeCloseTo(150, 9)
  })

  it('rounds a 150 degree corner at r5 with a 30 degree sweep', () => {
    const [entities, corner] = wedge(150)
    const [geo] = cornerPlan(entities, [corner], 5)
    expect(geo.tangentDistance).toBeCloseTo(1.339746, 6)
    expect(geo.sweepDeg).toBeCloseTo(30, 6)
    expect(geo.arc[4] - geo.arc[3]).toBeCloseTo(30, 9)
  })

  it('keeps every stored coordinate on the round quantum', () => {
    const [entities, corner] = wedge(30)
    const [geo] = cornerPlan(entities, [corner], 5)
    for (const value of [...geo.arc, ...geo.ta, ...geo.tb, ...geo.center, geo.radius, geo.tangentDistance]) {
      expect(value).toBe(Number(value.toFixed(6)))
    }
  })
})

// The L strip: 10 mm legs and a 1 mm wall. The outer corner is at the origin,
// the inner corner at (1, 1), so the two rounded corners are concentric at
// (1.8, 1.8) when the radii are 1.8 and 0.8.
const lStrip = (): FilletCornerSide[] => [
  line('out1', 10, 0, 0, 0),
  line('out2', 0, 0, 0, 10),
  line('in1', 0, 10, 1, 10),
  line('in2', 1, 10, 1, 1),
  line('in3', 1, 1, 10, 1),
  line('in4', 10, 1, 10, 0),
]

const outerCorner: FilletCorner = { a: 'out1', aVertex: 'end', b: 'out2', bVertex: 'start' }
const innerCorner: FilletCorner = { a: 'in3', aVertex: 'start', b: 'in2', bVertex: 'end' }

describe('planFilletGeometry material side', () => {
  it('classifies the L strip outer corner convex and the inner corner concave', () => {
    const [outer] = cornerPlan(lStrip(), [outerCorner], 1.8)
    expect(outer.side).toBe('convex')
    expectPoint(outer.center, [1.8, 1.8])

    const [inner] = cornerPlan(lStrip(), [innerCorner], 0.8)
    expect(inner.side).toBe('concave')
    expectPoint(inner.center, [1.8, 1.8])
  })

  it('classifies all four rectangle corners convex', () => {
    const entities = [
      line('b', 0, 0, 20, 0),
      line('r', 20, 0, 20, 10),
      line('t', 20, 10, 0, 10),
      line('l', 0, 10, 0, 0),
    ]
    const corners: FilletCorner[] = [
      { a: 'b', aVertex: 'end', b: 'r', bVertex: 'start' },
      { a: 'r', aVertex: 'end', b: 't', bVertex: 'start' },
      { a: 't', aVertex: 'end', b: 'l', bVertex: 'start' },
      { a: 'l', aVertex: 'end', b: 'b', bVertex: 'start' },
    ]
    const planned = cornerPlan(entities, corners, 3)
    expect(planned.map(geo => geo.side)).toEqual(['convex', 'convex', 'convex', 'convex'])
    expectPoint(planned[0].center, [17, 3])
    expectPoint(planned[1].center, [17, 7])
    expectPoint(planned[2].center, [3, 7])
    expectPoint(planned[3].center, [3, 3])
  })

  it('defaults an open chain with no material on either side to convex', () => {
    const [entities, corner] = wedge(90)
    const [geo] = cornerPlan(entities, [corner], 2)
    expect(geo.side).toBe('convex')
  })

  it('refuses an interior line whose two sides are both filled unless side is given', () => {
    // A square with a doubled spur from its corner into the interior. The two
    // coincident copies make the even-odd parity equal on both sides of the
    // spur, so it is not a boundary and cannot pick a facing.
    const entities = [
      line('b', -5, -5, 5, -5),
      line('r', 5, -5, 5, 5),
      line('t', 5, 5, -5, 5),
      line('l', -5, 5, -5, -5),
      line('d', -5, -5, 0, 0),
      line('d2', -5, -5, 0, 0),
    ]
    const corner: FilletCorner = { a: 'b', aVertex: 'start', b: 'd', bVertex: 'start' }
    const refused = planFilletGeometry(entities, [corner], 1)
    expect('reason' in refused).toBe(true)
    expect('reason' in refused && refused.reason).toContain('material on both sides')
    expect('reason' in refused && refused.reason).toContain('"d"')

    const [geo] = cornerPlan(entities, [{ ...corner, side: 'convex' }], 1)
    expect(geo.side).toBe('convex')
  })

  it('refuses a straight pair as already tangent even when side is given', () => {
    const entities = [
      line('a', -10, 0, 0, 0),
      line('b', 0, 0, 10, 0),
    ]
    const corner: FilletCorner = { a: 'a', aVertex: 'end', b: 'b', bVertex: 'start', side: 'convex' }
    const refused = planFilletGeometry(entities, [corner], 1)
    expect('reason' in refused).toBe(true)
    expect('reason' in refused && refused.reason).toMatch(/parallel|tangent|collinear/)
  })
})

describe('planFilletGeometry refusals', () => {
  it('names the line and the greatest radius when one trim exceeds its side', () => {
    const [entities, corner] = wedge(90, 10)
    const refused = planFilletGeometry(entities, [corner], 50)
    expect('reason' in refused).toBe(true)
    if (!('reason' in refused)) throw new Error('expected refusal')
    expect(refused.reason).toContain('"a"')
    expect(refused.reason).toContain('greatest radius is 10')
    expect(refused.maxRadius).toBe(10)
  })

  it('names the shared line and the common greatest radius when two trims sum past it', () => {
    const entities = [
      line('bottom', 0, 0, 100, 0),
      line('left', 0, 200, 0, 0),
      line('right', 100, 0, 100, 200),
    ]
    const corners: FilletCorner[] = [
      { a: 'left', aVertex: 'end', b: 'bottom', bVertex: 'start' },
      { a: 'bottom', aVertex: 'end', b: 'right', bVertex: 'start' },
    ]
    const refused = planFilletGeometry(entities, corners, 60)
    expect('reason' in refused).toBe(true)
    if (!('reason' in refused)) throw new Error('expected refusal')
    expect(refused.reason).toContain('"bottom"')
    expect(refused.reason).toContain('greatest radius is 50')
    expect(refused.maxRadius).toBe(50)
  })
})

describe('buildFilletCornerMap', () => {
  it('pairs coordinate-welded endpoints and refuses a T-junction', () => {
    const pair = buildFilletCornerMap('sk', [
      line('a', 10, 0, 0, 0),
      line('b', 0, 0, 0, 10),
    ], [])
    expect(pair['vertex:sk:a:end']).toMatchObject({
      partner: { entityId: 'b', vertexKey: 'start' },
    })

    // A third line meeting at the same coordinate makes every endpoint there
    // ambiguous rather than picking one pair silently.
    const junctionMap = buildFilletCornerMap('sk', [
      line('a', 10, 0, 0, 0),
      line('b', 0, 0, 0, 10),
      line('c', 0, 0, -10, 0),
    ], [])
    for (const key of ['vertex:sk:a:end', 'vertex:sk:b:start', 'vertex:sk:c:start']) {
      const junction = junctionMap[key]
      expect('reason' in junction && junction.reason).toContain('more than one line partner')
    }
  })

  it('uses coincident constraints even when coordinates differ slightly', () => {
    const entities = [
      line('a', 10, 0, 0, 0),
      line('b', 0.000001, 0, 0.000001, 10),
    ]
    const map = buildFilletCornerMap('sk', entities, [
      { id: 'k', kind: 'coincident', a: '$aend', b: '$bstart' },
    ])
    expect(map['vertex:sk:a:end']).toMatchObject({
      partner: { entityId: 'b', vertexKey: 'start' },
    })
  })
})
