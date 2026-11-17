import { describe, expect, it } from 'vitest'
import {
  AXIS_IN_PLANE_MIN,
  WRAP_AXIS_PERPENDICULAR,
  angleInRange,
  WrapRefusal,
  geometricOffset,
  hermiteChain,
  refuseCollapsedOffset,
  wrapMap,
  type Vec3,
  type WrapInput,
  type WrapSurface,
} from '../wrapMath'
import type { PlaneLike } from '../shared/planes'

// Front: normal +Z, sketch x -> +X, y -> +Y.
const FRONT: PlaneLike = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
// The same plane drawn with its sketch axes swapped (x -> +Y, y -> -X).
const FRONT_TURNED: PlaneLike = { origin: [0, 0, 0], x_axis: [0, 1, 0], y_axis: [-1, 0, 0], normal: [0, 0, 1] }

const R = 10
const CYL: WrapSurface = { kind: 'cylinder', origin: [0, 0, 0], axis: [0, 1, 0], radius: R }
const square = (cx: number, cy: number, half: number): number[][] => [
  [cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half],
]
const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const input = (surface: WrapSurface, footprint: number[][], extra: Partial<WrapInput> = {}): WrapInput => ({
  surface, concave: false, plane: FRONT, footprint, ...extra,
})

/** Arc length of the mapped polyline from p to q (fine sampling). */
function mappedLength(map: ReturnType<typeof wrapMap>, p: number[], q: number[], offset = 0): number {
  let len = 0
  let prev = map.point(p, offset)
  const n = 4000
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const cur = map.point([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t], offset)
    len += dist(prev, cur)
    prev = cur
  }
  return len
}

describe('wrapMath: cylinder', () => {
  const map = wrapMap(input(CYL, square(0, 0, 3)))

  it('lands the footprint centre on the facing generatrix', () => {
    const p = map.point([0, 0], 0)
    expect(dist(p, [0, 0, R])).toBeLessThan(1e-12)
    expect(map.facing).toEqual([0, 0, 1])
  })

  it('keeps arc length around and along', () => {
    // Around: a sketch run of 7 across the axis is a 7 long arc.
    expect(Math.abs(mappedLength(map, [-3.5, 0], [3.5, 0]) - 7)).toBeLessThan(1e-6)
    // Along: the axial run is a straight 5.
    expect(Math.abs(mappedLength(map, [0, -2], [0, 3]) - 5)).toBeLessThan(1e-9)
  })

  it('round trips a point to (a, d) in closed form', () => {
    for (const [x, y] of [[2, 1], [-4, 3], [0.5, -6]]) {
      const p = map.point([x, y], 0)
      // a is the height, d the arc from the facing generatrix toward +X.
      expect(Math.abs(p[1] - y)).toBeLessThan(1e-12)
      expect(Math.abs(R * Math.atan2(p[0], p[2]) - x)).toBeLessThan(1e-12)
      expect(Math.abs(Math.hypot(p[0], p[2]) - R)).toBeLessThan(1e-12)
    }
  })

  it('maps a sketch drawn with swapped axes as drawn', () => {
    // FRONT_TURNED's (y, -x) is FRONT's (x, y): the same world point.
    const turned = wrapMap(input(CYL, square(0, 0, 3), { plane: FRONT_TURNED }))
    for (const [x, y] of [[2, 1], [-4, 3]]) {
      expect(dist(turned.point([y, -x], 0), map.point([x, y], 0))).toBeLessThan(1e-12)
    }
  })

  it('a positive offset grows the radius along the normal', () => {
    const base = map.point([2, 1], 0)
    const top = map.point([2, 1], 1.5)
    expect(Math.abs(dist(base, top) - 1.5)).toBeLessThan(1e-12)
    expect(Math.abs(Math.hypot(top[0], top[2]) - (R + 1.5))).toBeLessThan(1e-12)
  })

  it('faces the far wall of a concave target', () => {
    const bore = wrapMap(input(CYL, square(0, 0, 3), { concave: true }))
    expect(dist(bore.point([0, 0], 0), [0, 0, -R])).toBeLessThan(1e-12)
    // +x in the sketch still moves toward +X on the far wall.
    expect(bore.point([1, 0], 0)[0]).toBeGreaterThan(0)
  })

  it('uses the affine uv with the facing point at u = pi', () => {
    const uv = map.uv as (p: number[]) => [number, number]
    expect(uv([0, 2])).toEqual([Math.PI, 2])
    const [u] = uv([R * 0.5, 0])
    expect(Math.abs(Math.abs(u - Math.PI) - 0.5)).toBeLessThan(1e-12)
  })

  it('maps a tilted plane as drawn, with no foreshortening', () => {
    // The plane through the axis tilted 30 degrees about X: the axis keeps an
    // in-plane component of cos 30.
    const c = Math.cos(Math.PI / 6)
    const s = Math.sin(Math.PI / 6)
    const tilted: PlaneLike = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, c, s], normal: [0, -s, c] }
    const m = wrapMap(input(CYL, square(0, 0, 2), { plane: tilted }))
    // An axial run of 4 in the sketch is 4 along the cylinder.
    expect(Math.abs(mappedLength(m, [0, -2], [0, 2]) - 4)).toBeLessThan(1e-9)
  })

  it('refuses a sketch plane perpendicular to the axis with the pinned sentence', () => {
    const top: PlaneLike = { origin: [0, 5, 0], x_axis: [1, 0, 0], y_axis: [0, 0, -1], normal: [0, 1, 0] }
    expect(() => wrapMap(input(CYL, square(0, 0, 1), { plane: top }))).toThrow(WRAP_AXIS_PERPENDICULAR)
  })

  it('accepts a plane tilted just past the perpendicular threshold', () => {
    const eps = AXIS_IN_PLANE_MIN * 4
    const n: Vec3 = [0, Math.cos(eps), Math.sin(eps)]
    const plane: PlaneLike = { origin: [0, 5, 0], x_axis: [1, 0, 0], y_axis: [0, -Math.sin(eps), Math.cos(eps)], normal: n }
    expect(() => wrapMap(input(CYL, square(0, 0, 1), { plane }))).not.toThrow()
  })

  it('refuses a footprint reaching half way round', () => {
    const wide = [[-Math.PI * R, -1], [Math.PI * R, -1], [Math.PI * R, 1], [-Math.PI * R, 1]]
    expect(() => wrapMap(input(CYL, wide))).toThrow(WrapRefusal)
    expect(() => wrapMap(input(CYL, wide))).toThrow(/under 180 degrees/)
    const almost = wide.map(([x, y]) => [x * 0.99, y])
    expect(() => wrapMap(input(CYL, almost))).not.toThrow()
  })
})

describe('wrapMath: cone', () => {
  // Radius 10 at y = 0, opening 20 degrees along +Y.
  const alpha = (20 * Math.PI) / 180
  const cone: WrapSurface = { kind: 'cone', origin: [0, 0, 0], axis: [0, 1, 0], refRadius: 10, semiAngle: alpha }
  const map = wrapMap(input(cone, square(0, 4, 2)))

  it('sets the reference parallel at the footprint centre', () => {
    // a0 = 4 is the axial height; its parallel radius is 10 + 4 tan(alpha).
    expect(Math.abs(map.r0 - (10 + 4 * Math.tan(alpha)))).toBeLessThan(1e-12)
    const p = map.point([0, 4], 0)
    expect(Math.abs(p[1] - 4)).toBeLessThan(1e-12)
    expect(Math.abs(p[2] - map.r0)).toBeLessThan(1e-12)
  })

  it('keeps meridian and parallel lengths at the reference', () => {
    // Along: the sketch axial run is meridian arc length (the slant).
    expect(Math.abs(mappedLength(map, [0, 3], [0, 5]) - 2)).toBeLessThan(1e-9)
    // Around: a short arc on the reference parallel keeps its length.
    expect(Math.abs(mappedLength(map, [-1, 4], [1, 4]) - 2)).toBeLessThan(1e-6)
  })

  it('offsets along the cone normal with the same parameters', () => {
    const base = map.point([1, 4.5], 0)
    const top = map.point([1, 4.5], 0.8)
    expect(Math.abs(dist(base, top) - 0.8)).toBeLessThan(1e-12)
    // The step is normal to the slant direction.
    const along = map.point([1, 4.6], 0)
    const step = [along[0] - base[0], along[1] - base[1], along[2] - base[2]]
    const off = [top[0] - base[0], top[1] - base[1], top[2] - base[2]]
    expect(Math.abs(step[0] * off[0] + step[1] * off[1] + step[2] * off[2])).toBeLessThan(1e-9)
  })

  it('refuses a footprint centred past the apex', () => {
    const narrow: WrapSurface = { kind: 'cone', origin: [0, 0, 0], axis: [0, 1, 0], refRadius: 2, semiAngle: -alpha }
    expect(() => wrapMap(input(narrow, square(0, 10, 1)))).toThrow(/apex/)
  })
})

describe('wrapMath: torus', () => {
  // A ring about Y, major 20, tube 5: the outer equator faces the sketch at z = 25.
  const torus: WrapSurface = { kind: 'torus', origin: [0, 0, 0], axis: [0, 1, 0], majorRadius: 20, minorRadius: 5 }
  const map = wrapMap(input(torus, square(0, 0, 2)))

  it('lands the centre on the outer equator', () => {
    expect(dist(map.point([0, 0], 0), [0, 0, 25])).toBeLessThan(1e-12)
    expect(map.r0).toBe(25)
  })

  it('keeps the meridian arc along the tube and the parallel arc around the ring', () => {
    expect(Math.abs(mappedLength(map, [0, -2], [0, 2]) - 4)).toBeLessThan(1e-6)
    expect(Math.abs(mappedLength(map, [-2, 0], [2, 0]) - 4)).toBeLessThan(1e-6)
  })

  it('takes the inner half when asked, on the far side of the ring where it faces the sketch', () => {
    // A donut's inner half turns its material toward the axis, so the wall the
    // sketch sees through the hole is the one beyond the axis.
    const inner = wrapMap(input(torus, square(0, 0, 1), { tubeSide: 'inner' }))
    expect(dist(inner.point([0, 0], 0), [0, 0, -15])).toBeLessThan(1e-12)
    // +y still climbs the axis and +x still moves toward +X, as drawn.
    expect(inner.point([0, 1], 0)[1]).toBeGreaterThan(0)
    expect(inner.point([1, 0], 0)[0]).toBeGreaterThan(0)
  })

  it('faces the far wall of a concave outer half (a groove inside a bore)', () => {
    const groove = wrapMap(input(torus, square(0, 0, 1), { concave: true }))
    expect(dist(groove.point([0, 0], 0), [0, 0, -25])).toBeLessThan(1e-12)
    expect(groove.point([1, 0], 0)[0]).toBeGreaterThan(0)
  })

  it('refuses a footprint reaching round the tube', () => {
    const r = 5
    expect(() => wrapMap(input(torus, square(0, 0, Math.PI * r + 0.01)))).toThrow(/it would meet itself round the tube/)
  })

  it('reports the tube angle a face range is tested against', () => {
    expect(map.tubeAngle).toBe(0)
    const inner = wrapMap(input(torus, square(0, 0, 1), { tubeSide: 'inner' }))
    expect(inner.tubeAngle).toBeCloseTo(Math.PI, 12)
    // A full tube spans [0, 2 pi]: the outer equator's 0 and a lifted -0.3 are in it.
    expect(angleInRange(0, [0, 2 * Math.PI])).toBe(true)
    expect(angleInRange(-0.3, [0, 2 * Math.PI])).toBe(true)
    // An inner fillet spanning [pi/2, 3pi/2] holds the inner half only.
    expect(angleInRange(0, [Math.PI / 2, (3 * Math.PI) / 2])).toBe(false)
    expect(angleInRange(Math.PI, [Math.PI / 2, (3 * Math.PI) / 2])).toBe(true)
  })

  it('refuses a footprint centred above the tube', () => {
    expect(() => wrapMap(input(torus, square(0, 7, 1)))).toThrow(/tube radius/)
  })
})

describe('wrapMath: sphere', () => {
  const sphere: WrapSurface = { kind: 'sphere', center: [0, 0, 0], radius: R }
  const map = wrapMap(input(sphere, square(0, 0, 3)))

  it('keeps every radial distance from the projected centre', () => {
    const facing = map.point([0, 0], 0)
    expect(dist(facing, [0, 0, R])).toBeLessThan(1e-12)
    for (const [x, y] of [[3, 0], [0, -4], [2, 2], [-5, 1]]) {
      const p = map.point([x, y], 0)
      const geodesic = R * Math.acos(Math.max(-1, Math.min(1, p[2] / R)))
      expect(Math.abs(geodesic - Math.hypot(x, y))).toBeLessThan(1e-9)
      expect(Math.abs(Math.hypot(p[0], p[1], p[2]) - R)).toBeLessThan(1e-12)
      // The direction from the facing point is the sketch direction.
      expect(Math.abs(Math.atan2(p[1], p[0]) - Math.atan2(y, x))).toBeLessThan(1e-12)
    }
  })

  it('refuses a footprint reaching a quarter great circle', () => {
    const q = (Math.PI * R) / 2
    expect(() => wrapMap(input(sphere, [[q, 0], [0, 1], [-1, 0]]))).toThrow(/quarter great circle/)
    expect(() => wrapMap(input(sphere, [[q * 0.99, 0], [0, 1], [-1, 0]]))).not.toThrow()
  })

  it('faces the far wall of a cavity', () => {
    const cavity = wrapMap(input(sphere, square(0, 0, 1), { concave: true }))
    expect(dist(cavity.point([0, 0], 0), [0, 0, -R])).toBeLessThan(1e-12)
  })
})

describe('wrapMath: height', () => {
  it('signs the offset by operation and convexity', () => {
    expect(geometricOffset(2, 'add', false)).toBe(2)
    expect(geometricOffset(2, 'new', false)).toBe(2)
    expect(geometricOffset(2, 'cut', false)).toBe(-2)
    expect(geometricOffset(2, 'add', true)).toBe(-2)
    expect(geometricOffset(2, 'cut', true)).toBe(2)
  })

  it('refuses a height that reaches the axis', () => {
    const fp = square(0, 0, 1)
    const map = wrapMap(input(CYL, fp))
    expect(() => refuseCollapsedOffset(CYL, map, -R, fp)).toThrow(/reaches through the target's axis/)
    expect(() => refuseCollapsedOffset(CYL, map, -R * 0.9, fp)).not.toThrow()
  })
})

describe('wrapMath: Hermite chain', () => {
  it('fits a mapped circle within the tolerance with exact ends', () => {
    const map = wrapMap(input(CYL, square(0, 0, 3)))
    const f = (t: number): Vec3 => map.point([3 * Math.cos(t), 3 * Math.sin(t)], 0)
    const start = f(0)
    const end = f(Math.PI)
    const chain = hermiteChain(f, 0, Math.PI, 1e-6, start, end)
    expect(chain.deviation).toBeLessThanOrEqual(1e-6)
    expect(chain.poles[0]).toBe(start)
    expect(chain.poles[chain.poles.length - 1]).toBe(end)
    expect(chain.poles.length).toBe(3 * (chain.knots.length - 1) + 1)
  })

  it('refuses a curve it cannot fit', () => {
    const wild = (t: number): Vec3 => [Math.sin(t * 1e4), 0, 0]
    expect(() => hermiteChain(wild, 0, 1, 1e-9, wild(0), wild(1))).toThrow(/could not be fitted/)
  })
})
