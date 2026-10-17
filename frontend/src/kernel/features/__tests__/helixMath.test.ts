// Pure helix math: the mode table, the length formula and the four-way
// independence invariant (frame x start_angle x hand x direction). No OCC.

import { describe, it, expect } from 'vitest'
import {
  resolveHelixParams,
  helixFrame,
  helixPoint,
  helixTangent,
  helixSamples,
  chirality,
  startUV,
  endParam,
  type HelixReference,
} from '../helixMath'
import type { HelixFeatureDef } from '@/types/cad'

const TWO_PI = 2 * Math.PI

// A boss face: axis +Z, low end at the origin, radius 5, axial extent 12.
function faceRef(): HelixReference {
  return { kind: 'cylinderface', axis: [0, 0, 1], origin: [0, 0, 0], radius: 5, extent: 12 }
}

function baseDef(over: Partial<HelixFeatureDef> = {}): HelixFeatureDef {
  return {
    radius_mode: 'derived',
    mode: 'pitch_turns',
    pitch: 2,
    turns: 5,
    height: 10,
    helix_angle: 5,
    offset: 0,
    start_angle: 0,
    hand: 'right',
    direction: 'normal',
    ...over,
  }
}

function build(def: Partial<HelixFeatureDef>, ref: HelixReference = faceRef()) {
  const d = baseDef(def)
  const params = resolveHelixParams(d, ref)
  return { params, desc: helixFrame(ref, params, d) }
}

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

describe('resolveHelixParams', () => {
  it('pitch_turns: height = pitch * turns', () => {
    const p = resolveHelixParams(baseDef({ mode: 'pitch_turns', pitch: 2, turns: 5 }), faceRef())
    expect(p.height).toBeCloseTo(10)
    expect(p.turns).toBeCloseTo(5)
  })

  it('pitch_height: turns = height / pitch', () => {
    const p = resolveHelixParams(baseDef({ mode: 'pitch_height', pitch: 2, height: 10 }), faceRef())
    expect(p.turns).toBeCloseTo(5)
  })

  it('turns_height: pitch = height / turns', () => {
    const p = resolveHelixParams(baseDef({ mode: 'turns_height', turns: 5, height: 10 }), faceRef())
    expect(p.pitch).toBeCloseTo(2)
  })

  it('angle_turns: pitch = C tan(angle), height = pitch * turns', () => {
    const ref: HelixReference = { kind: 'cylinderface', axis: [0, 0, 1], origin: [0, 0, 0], radius: 10, extent: 100 }
    const p = resolveHelixParams(baseDef({ mode: 'angle_turns', helix_angle: 45, turns: 2 }), ref)
    expect(p.pitch).toBeCloseTo(20 * Math.PI)
    expect(p.height).toBeCloseTo(40 * Math.PI)
  })

  it('angle_height round-trips angle_turns', () => {
    const ref: HelixReference = { kind: 'cylinderface', axis: [0, 0, 1], origin: [0, 0, 0], radius: 10, extent: 100 }
    const at = resolveHelixParams(baseDef({ mode: 'angle_turns', helix_angle: 45, turns: 2 }), ref)
    const ah = resolveHelixParams(baseDef({ mode: 'angle_height', helix_angle: 45, height: at.height }), ref)
    expect(ah.turns).toBeCloseTo(2)
    expect(ah.pitch).toBeCloseTo(at.pitch)
  })

  it('length = turns * sqrt((2 pi r)^2 + pitch^2)', () => {
    const p = resolveHelixParams(baseDef({ mode: 'pitch_turns', pitch: 2, turns: 5 }), faceRef())
    const C = TWO_PI * 5
    expect(p.length).toBeCloseTo(5 * Math.sqrt(C * C + 4))
  })

  it('errors carry their own message', () => {
    expect(() => resolveHelixParams(baseDef({ mode: 'pitch_turns', pitch: 0 }), faceRef())).toThrow(/pitch/)
    expect(() => resolveHelixParams(baseDef({ mode: 'pitch_turns', turns: 0 }), faceRef())).toThrow(/turns/)
    expect(() => resolveHelixParams(baseDef({ mode: 'pitch_height', pitch: 2, height: 0 }), faceRef())).toThrow(/height/)
    expect(() => resolveHelixParams(baseDef({ mode: 'angle_turns', helix_angle: 0, turns: 2 }), faceRef())).toThrow(/angle/)
    expect(() => resolveHelixParams(baseDef({ mode: 'angle_turns', helix_angle: 90, turns: 2 }), faceRef())).toThrow(/90/)
    expect(() => resolveHelixParams(baseDef({ radius_mode: 'entered', radius: -1 }), faceRef())).toThrow(/radius/)
    const straight: HelixReference = { kind: 'straight_edge', axis: [0, 0, 1], origin: [0, 0, 0], extent: 10 }
    expect(() => resolveHelixParams(baseDef({ radius_mode: 'derived' }), straight)).toThrow(/straight-edge/)
    // A straight edge carries an `extent` (its length), so height_from_reference
    // must be refused by KIND, not by the missing extent.
    expect(() => resolveHelixParams(baseDef({ radius_mode: 'entered', radius: 3, mode: 'pitch_height', pitch: 2, height_from_reference: true }), straight)).toThrow(/height_from_reference/)
    const edge: HelixReference = { kind: 'circular_edge', axis: [0, 0, 1], origin: [0, 0, 0], radius: 5 }
    expect(() => resolveHelixParams(baseDef({ height_from_reference: true }), edge)).toThrow(/height_from_reference/)
  })

  it('height_from_reference takes the face extent as height', () => {
    const p = resolveHelixParams(
      baseDef({ mode: 'pitch_height', pitch: 2, height_from_reference: true }),
      faceRef(),
    )
    expect(p.height).toBeCloseTo(12)
    expect(p.turns).toBeCloseTo(6)
  })
})

describe('helixPoint and length agreement', () => {
  it('sampled polyline length matches the analytic length', () => {
    const { params, desc } = build({ mode: 'pitch_turns', pitch: 2, turns: 5 })
    const pts = helixSamples(desc, 64)
    let sum = 0
    for (let i = 1; i < pts.length; i++) sum += dist(pts[i], pts[i - 1])
    // Chord length underestimates arc length; a fine sampling closes the gap.
    expect(sum).toBeGreaterThan(params.length * 0.999)
    expect(sum).toBeLessThanOrEqual(params.length + 1e-6)
  })

  it('turns 2.25 keep the end angle at start + 90 deg', () => {
    const { desc } = build({ mode: 'pitch_turns', pitch: 1, turns: 2.25, start_angle: 0 })
    const end = helixPoint(desc, endParam(desc))
    const radial = sub(end, desc.origin)
    const { xAxis, refAxis } = desc
    const y0 = [
      refAxis[1] * xAxis[2] - refAxis[2] * xAxis[1],
      refAxis[2] * xAxis[0] - refAxis[0] * xAxis[2],
      refAxis[0] * xAxis[1] - refAxis[1] * xAxis[0],
    ]
    const angle = Math.atan2(dot(radial, y0), dot(radial, xAxis))
    // 2.25 turns = 4.5 pi = start + 90 deg modulo 2 pi.
    const wrapped = Math.atan2(Math.sin(angle - Math.PI / 2), Math.cos(angle - Math.PI / 2))
    expect(Math.abs(wrapped)).toBeLessThan(1e-9)
  })
})

describe('four-way independence', () => {
  const HANDS = ['right', 'left'] as const
  const DIRECTIONS = ['normal', 'reverse'] as const
  const STARTS = [0, 37.5]

  it('the start point depends only on start_angle and offset, never on hand', () => {
    for (const direction of DIRECTIONS) {
      for (const start of STARTS) {
        const pts = HANDS.map((hand) => helixPoint(build({ hand, direction, start_angle: start, offset: 3 }).desc, 0))
        // Same radial direction and same axial placement: the start point is
        // identical for both hands.
        expect(dist(pts[0], pts[1])).toBeLessThan(1e-12)
      }
    }
  })

  it('direction changes only which end of a face it starts at', () => {
    const normal = helixPoint(build({ direction: 'normal', start_angle: 20 }).desc, 0)
    const reverse = helixPoint(build({ direction: 'reverse', start_angle: 20 }).desc, 0)
    // The radial (in-plane) parts agree; only the axial z differs.
    expect(normal[0]).toBeCloseTo(reverse[0])
    expect(normal[1]).toBeCloseTo(reverse[1])
    expect(normal[2]).toBeCloseTo(0)
    expect(reverse[2]).toBeCloseTo(12)
  })

  it('chirality equals hand for both directions', () => {
    for (const direction of DIRECTIONS) {
      expect(chirality(build({ hand: 'right', direction }).desc)).toBe(1)
      expect(chirality(build({ hand: 'left', direction }).desc)).toBe(-1)
    }
  })

  it('reverse ends at the low end along a0 and climbs -a0', () => {
    const { desc } = build({ direction: 'reverse', mode: 'pitch_height', pitch: 1, height_from_reference: true })
    const end = helixPoint(desc, endParam(desc))
    // height_from_reference = 12 == extent, so the reverse climb lands at z 0.
    expect(end[2]).toBeCloseTo(0)
    // The tangent points down the reference axis.
    expect(helixTangent(desc, 0)[2]).toBeLessThan(0)
  })

  it('start_angle +360 gives the same curve, +0.1 moves the start by an arc', () => {
    const a = build({ start_angle: 10, hand: 'right', direction: 'reverse' })
    const b = build({ start_angle: 370, hand: 'right', direction: 'reverse' })
    const pa = helixSamples(a.desc, 8)
    const pb = helixSamples(b.desc, 8)
    for (let i = 0; i < pa.length; i++) expect(dist(pa[i], pb[i])).toBeLessThan(1e-9)

    const fine = build({ start_angle: 10.1 })
    const coarse = build({ start_angle: 10 })
    const moved = dist(helixPoint(fine.desc, 0), helixPoint(coarse.desc, 0))
    // The start points sit on a circle of radius 5: the chord for 0.1 deg.
    expect(moved).toBeCloseTo(2 * 5 * Math.sin((0.1 * Math.PI) / 180 / 2), 9)
  })

  it('right and left with the same start mirror through the axis-start-radius plane', () => {
    const start = 33
    const right = build({ hand: 'right', start_angle: start }).desc
    const left = build({ hand: 'left', start_angle: start }).desc
    // Reflect every left sample across the plane spanned by a0 and radial(start).
    const saRad = (start * Math.PI) / 180
    for (let i = 0; i <= 12; i++) {
      const t = (endParam(right) * i) / 12
      const p = helixPoint(left, t)
      const r = sub(p, left.origin)
      const axial = dot(r, left.refAxis)
      const rad = [
        r[0] - axial * left.refAxis[0],
        r[1] - axial * left.refAxis[1],
        r[2] - axial * left.refAxis[2],
      ]
      const y0 = [
        left.refAxis[1] * left.xAxis[2] - left.refAxis[2] * left.xAxis[1],
        left.refAxis[2] * left.xAxis[0] - left.refAxis[0] * left.xAxis[2],
        left.refAxis[0] * left.xAxis[1] - left.refAxis[1] * left.xAxis[0],
      ]
      const u = [
        Math.cos(saRad) * left.xAxis[0] + Math.sin(saRad) * y0[0],
        Math.cos(saRad) * left.xAxis[1] + Math.sin(saRad) * y0[1],
        Math.cos(saRad) * left.xAxis[2] + Math.sin(saRad) * y0[2],
      ]
      const n = [
        -Math.sin(saRad) * left.xAxis[0] + Math.cos(saRad) * y0[0],
        -Math.sin(saRad) * left.xAxis[1] + Math.cos(saRad) * y0[1],
        -Math.sin(saRad) * left.xAxis[2] + Math.cos(saRad) * y0[2],
      ]
      const alongStart = dot(rad, u)
      const alongNormal = dot(rad, n)
      const reflected = [
        left.origin[0] + axial * left.refAxis[0] + alongStart * u[0] - alongNormal * n[0],
        left.origin[1] + axial * left.refAxis[1] + alongStart * u[1] - alongNormal * n[1],
        left.origin[2] + axial * left.refAxis[2] + alongStart * u[2] - alongNormal * n[2],
      ]
      expect(dist(reflected, helixPoint(right, t))).toBeLessThan(1e-9)
    }
  })

  it('x0 comes from a0: flipping direction does not change x0', () => {
    const n = build({ direction: 'normal' }).desc
    const r = build({ direction: 'reverse' }).desc
    expect(dist(n.xAxis, r.xAxis)).toBeLessThan(1e-12)
  })

  it('a sketch circle uses its sketch x_axis', () => {
    const ref: HelixReference = {
      kind: 'sketch_circle', axis: [0, 1, 0], origin: [1, 2, 3], radius: 4, xAxis: [1, 0, 0],
    }
    const { desc } = build({}, ref)
    expect(dist(desc.xAxis, [1, 0, 0])).toBeLessThan(1e-12)
  })
})

describe('startUV', () => {
  it('mirrors the in-frame start angle under reverse', () => {
    const n = build({ direction: 'normal', start_angle: 30 }).desc
    const r = build({ direction: 'reverse', start_angle: 30 }).desc
    expect(startUV(n).u).toBeCloseTo((30 * Math.PI) / 180)
    expect(startUV(r).u).toBeCloseTo(-(30 * Math.PI) / 180)
  })
})
