import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  builtinSectionFrame,
  clampSectionTilt,
  offsetFramePoint,
  resolveSectionFrame,
  sectionFrameKey,
  sectionOffsetFromDrag,
  sectionOffsetFromTiltedDrag,
  sectionPlaneFromFrame,
  tiltedSectionFrame,
} from '@/viewport/sectionPlane'
import { normalToFrame } from '@/kernel/types3d'
import type { Vec3 } from '@/utils/vec3'

const NO_SOURCES = {
  planeTransform: () => null,
  faceFrame: () => null,
}

// Front: normal +Z, in-plane u +X, v +Y. The frame most of these tests turn.
const FRONT = { normal: [0, 0, 1] as Vec3, point: [0, 0, 0] as Vec3, u: [1, 0, 0] as Vec3, v: [0, 1, 0] as Vec3 }
const DEG = Math.PI / 180

function expectVec(actual: readonly number[], expected: readonly number[]): void {
  expect(actual[0]).toBeCloseTo(expected[0], 10)
  expect(actual[1]).toBeCloseTo(expected[1], 10)
  expect(actual[2]).toBeCloseTo(expected[2], 10)
}

function cross(a: readonly number[], b: readonly number[]): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

describe('builtin section planes', () => {
  it('names the same normals and axes as the builtin sketch planes', () => {
    expect(builtinSectionFrame('front').normal).toEqual([0, 0, 1])
    expect(builtinSectionFrame('top').normal).toEqual([0, 1, 0])
    expect(builtinSectionFrame('right').normal).toEqual([1, 0, 0])
    expect(builtinSectionFrame('front').u).toEqual([1, 0, 0])
    expect(builtinSectionFrame('front').v).toEqual([0, 1, 0])
    expect(builtinSectionFrame('top').u).toEqual([1, 0, 0])
    expect(builtinSectionFrame('top').v).toEqual([0, 0, -1])
    expect(builtinSectionFrame('right').u).toEqual([0, 0, -1])
    expect(builtinSectionFrame('right').v).toEqual([0, 1, 0])
    for (const frame of [builtinSectionFrame('front'), builtinSectionFrame('top'), builtinSectionFrame('right')]) {
      expect(frame.point).toEqual([0, 0, 0])
      expectVec(cross(frame.u, frame.v), frame.normal)
    }
  })
})

describe('sectionPlaneFromFrame', () => {
  it('keeps the half behind the source normal by default', () => {
    // three clips the negative-distance half, so keeping the far half needs the
    // plane normal negated. This is what puts the cut face toward the viewer
    // when the camera looks along the source normal.
    const plane = sectionPlaneFromFrame(FRONT, 0, false)
    expect(plane.normal.x).toBeCloseTo(0, 12)
    expect(plane.normal.y).toBeCloseTo(0, 12)
    expect(plane.normal.z).toBeCloseTo(-1, 12)
    expect(plane.constant).toBeCloseTo(0, 12)
    expect(plane.distanceToPoint(new THREE.Vector3(0, 0, 2))).toBeCloseTo(-2, 12)
    expect(plane.distanceToPoint(new THREE.Vector3(0, 0, -2))).toBeCloseTo(2, 12)
  })

  it('moves along the source normal with the offset', () => {
    const plane = sectionPlaneFromFrame(FRONT, 4, false)
    expect(plane.constant).toBeCloseTo(4, 12)
    // The plane now passes through z = 4.
    expect(plane.distanceToPoint(new THREE.Vector3(0, 0, 4))).toBeCloseTo(0, 12)
  })

  it('flipped negates both the normal and the constant', () => {
    const upright = sectionPlaneFromFrame(FRONT, 4, false)
    const flipped = sectionPlaneFromFrame(FRONT, 4, true)
    expect(flipped.normal.z).toBeCloseTo(1, 12)
    expect(flipped.constant).toBeCloseTo(-upright.constant, 12)
    // Same plane, other half kept.
    expect(flipped.distanceToPoint(new THREE.Vector3(0, 0, 4))).toBeCloseTo(0, 12)
    expect(Math.sign(flipped.distanceToPoint(new THREE.Vector3(0, 0, 8))))
      .toBe(-Math.sign(upright.distanceToPoint(new THREE.Vector3(0, 0, 8))))
  })

  it('is bit-identical to the untilted formula for every builtin and for a face', () => {
    // The regression guard the tilt feature needs: a section nobody turned must
    // not move a pixel.
    const face = resolveSectionFrame({ kind: 'query', query: '?face' }, {
      planeTransform: () => null,
      faceFrame: () => ({ normal: [0.6, 0.8, 0], point: [4, 5, 6] }),
    })!
    const frames = [
      builtinSectionFrame('front'),
      builtinSectionFrame('top'),
      builtinSectionFrame('right'),
      face,
    ]
    for (const frame of frames) {
      for (const offset of [0, 3.25]) {
        for (const flipped of [false, true]) {
          const before = new THREE.Plane().setFromNormalAndCoplanarPoint(
            new THREE.Vector3(...frame.normal),
            new THREE.Vector3(...offsetFramePoint(frame, offset)),
          )
          if (!flipped) before.negate()
          const after = sectionPlaneFromFrame(frame, offset, flipped)
          expect(after.normal.toArray()).toEqual(before.normal.toArray())
          expect(after.constant).toBe(before.constant)
        }
      }
    }
  })

  it('moves the point helper along the normal', () => {
    expect(offsetFramePoint({ ...FRONT, normal: [0, 1, 0], point: [1, 2, 3] }, 5)).toEqual([1, 7, 3])
  })

  it('keys a frame by value, so an unchanged plane is not a change', () => {
    const a = { normal: [0, 0, 1] as Vec3, point: [1, 2, 3] as Vec3, u: [1, 0, 0] as Vec3, v: [0, 1, 0] as Vec3 }
    const b = { normal: [0, 0, 1] as Vec3, point: [1, 2, 3] as Vec3, u: [1, 0, 0] as Vec3, v: [0, 1, 0] as Vec3 }
    expect(sectionFrameKey(a)).toBe(sectionFrameKey(b))
    expect(sectionFrameKey(a)).not.toBe(sectionFrameKey({ ...a, point: [1, 2, 4] }))
    // A user plane's in-plane spin can turn while its normal does not.
    expect(sectionFrameKey(a)).not.toBe(sectionFrameKey({ ...a, u: [0, 1, 0], v: [-1, 0, 0] }))
    expect(sectionFrameKey(null)).toBe('none')
  })
})

describe('tilt', () => {
  it('pitches right-handed about the frame u (front: +Z towards -Y)', () => {
    // 85 is the steepest the section accepts, so the sign is pinned there.
    const tilted = tiltedSectionFrame(FRONT, { pitch: 85 * DEG, yaw: 0 })
    expectVec(tilted.normal, [0, -Math.sin(85 * DEG), Math.cos(85 * DEG)])
    expect(tilted.normal[1]).toBeLessThan(0)
    expectVec(tilted.pitchAxis, [1, 0, 0])
    expectVec(tilted.yawAxis, [0, Math.cos(85 * DEG), Math.sin(85 * DEG)])
    // The plane really is built from that normal.
    expectVec(sectionPlaneFromFrame(FRONT, 0, true, { pitch: 85 * DEG, yaw: 0 }).normal.toArray(), tilted.normal)
  })

  it('yaws about the source v, 30 degrees alone rotates the normal about +Y', () => {
    const tilted = tiltedSectionFrame(FRONT, { pitch: 0, yaw: 30 * DEG })
    expectVec(tilted.normal, [Math.sin(30 * DEG), 0, Math.cos(30 * DEG)])
    expectVec(tilted.yawAxis, [0, 1, 0])
  })

  it('pitches first, then yaws about the pitched v', () => {
    const pitch = 35 * DEG
    const yaw = 40 * DEG
    const tilted = tiltedSectionFrame(FRONT, { pitch, yaw })

    // The pitched v, and the yaw of the pitched normal about it.
    const pitchedV: Vec3 = [0, Math.cos(pitch), Math.sin(pitch)]
    const pitchedNormal: Vec3 = [0, -Math.sin(pitch), Math.cos(pitch)]
    const axis = pitchedV
    const c = Math.cos(yaw)
    const s = Math.sin(yaw)
    const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    const kxv = cross(axis, pitchedNormal)
    const expected: Vec3 = [
      pitchedNormal[0] * c + kxv[0] * s + axis[0] * dot(axis, pitchedNormal) * (1 - c),
      pitchedNormal[1] * c + kxv[1] * s + axis[1] * dot(axis, pitchedNormal) * (1 - c),
      pitchedNormal[2] * c + kxv[2] * s + axis[2] * dot(axis, pitchedNormal) * (1 - c),
    ]
    expectVec(tilted.normal, expected)
    // The yaw ring is drawn around the pitched v, and the pitch ring around u.
    expectVec(tilted.yawAxis, pitchedV)
    expectVec(tilted.pitchAxis, [1, 0, 0])
  })

  it('clamps any requested tilt to 85 degrees from the source normal', () => {
    const far = { pitch: 60 * DEG, yaw: 80 * DEG }
    const clamped = clampSectionTilt(far)
    const tilted = tiltedSectionFrame(FRONT, far)
    const dotProduct = tilted.normal[2]  // FRONT's normal is +Z
    // Never steeper than the limit. Clamping two angles that were both out of
    // the cone lands just inside it, so this is a bound, not an equality.
    expect(dotProduct).toBeGreaterThanOrEqual(Math.cos(85 * DEG) - 1e-12)
    expect(Math.acos(dotProduct)).toBeLessThanOrEqual(85 * DEG + 1e-9)
    expect(clamped.pitch).toBeLessThan(far.pitch)
    expect(clamped.yaw).toBeLessThan(far.yaw)
    // A pitch request alone holds at a constant clamp while the yaw is zero.
    expect(clampSectionTilt({ pitch: 120 * DEG, yaw: 0 }).pitch).toBeCloseTo(85 * DEG, 10)
    expect(clampSectionTilt({ pitch: 0, yaw: -120 * DEG }).yaw).toBeCloseTo(-85 * DEG, 10)
  })
})

describe('resolveSectionFrame', () => {
  it('resolves a builtin without asking the scene', () => {
    expect(resolveSectionFrame({ kind: 'builtin', id: 'top' }, NO_SOURCES)).toEqual({
      normal: [0, 1, 0],
      point: [0, 0, 0],
      u: [1, 0, 0],
      v: [0, 0, -1],
    })
  })

  it('resolves a user plane from its solved transform rows', () => {
    const frame = resolveSectionFrame({ kind: 'query', query: 'Plane1' }, {
      planeTransform: q => q === 'Plane1'
        ? { rotation: [1, 0, 0, 0, 0, -1, 0, 1, 0], origin: [1, 2, 3] }
        : null,
      faceFrame: () => null,
    })
    expect(frame).not.toBeNull()
    expect(frame!.normal).toEqual([0, 1, 0])
    expect(frame!.point).toEqual([1, 2, 3])
    expect(frame!.u).toEqual([1, 0, 0])
    expect(frame!.v).toEqual([0, 0, -1])
    expectVec(cross(frame!.u, frame!.v), frame!.normal)
  })

  it('resolves a planar face from its frame when no plane transform matches', () => {
    const frame = resolveSectionFrame({ kind: 'query', query: '?face' }, {
      planeTransform: () => null,
      faceFrame: q => q === '?face' ? { normal: [0, 0, 2], point: [4, 5, 6] } : null,
    })
    // The normal is normalized so offset means world distance.
    expect(frame).not.toBeNull()
    expect(frame!.normal).toEqual([0, 0, 1])
    expect(frame!.point).toEqual([4, 5, 6])
    // The rings then line up with the axes a sketch on that face would have.
    const axes = normalToFrame([0, 0, 1])
    expect(frame!.u).toEqual(axes.x_axis)
    expect(frame!.v).toEqual(axes.y_axis)
    expectVec(cross(frame!.u, frame!.v), frame!.normal)
  })

  it('forwards the stored pickKey so a shared face query resolves to the clicked owner', () => {
    const seen: Array<string | undefined> = []
    resolveSectionFrame({ kind: 'query', query: '?dup', pickKey: 'ex2/body_2#face#0' }, {
      planeTransform: () => null,
      faceFrame: (_q, pickKey) => {
        seen.push(pickKey)
        return { normal: [0, 0, 1], point: [2, 0, 0] }
      },
    })
    expect(seen).toEqual(['ex2/body_2#face#0'])
  })

  it('returns null when the picked plane or face no longer resolves', () => {
    expect(resolveSectionFrame({ kind: 'query', query: 'gone' }, NO_SOURCES)).toBeNull()
  })

  it('refuses a degenerate normal instead of clipping with NaN', () => {
    expect(resolveSectionFrame({ kind: 'query', query: 'bad' }, {
      planeTransform: () => ({ rotation: [0, 0, 0, 0, 0, 0, 0, 0, 0], origin: [0, 0, 0] }),
      faceFrame: () => null,
    })).toBeNull()
  })
})

describe('sectionOffsetFromDrag', () => {
  it('maps axis travel straight onto the offset', () => {
    expect(sectionOffsetFromDrag(3, 10, 14)).toBe(7)
    expect(sectionOffsetFromDrag(-2, 0, -1.5)).toBe(-3.5)
  })
})

describe('sectionOffsetFromTiltedDrag', () => {
  it('travelling t along the tilted normal moves the cut by exactly t', () => {
    const tilt = { pitch: 35 * DEG, yaw: 40 * DEG }
    const n = tiltedSectionFrame(FRONT, tilt).normal
    const start = 3
    const travel = 7.5
    const next = sectionOffsetFromTiltedDrag(start, travel, FRONT, tilt)

    const g0 = offsetFramePoint(FRONT, start)
    const g1 = offsetFramePoint(FRONT, next)
    const along = (g1[0] - g0[0]) * n[0] + (g1[1] - g0[1]) * n[1] + (g1[2] - g0[2]) * n[2]
    expect(along).toBeCloseTo(travel, 10)
    // The pivot stayed on the source-normal line, which is what keeps the
    // Offset box meaningful.
    expect(g1[0]).toBeCloseTo(0, 12)
    expect(g1[1]).toBeCloseTo(0, 12)
    expect(g1[2]).toBeCloseTo(start + travel / (n[2]), 10)
  })

  it('holds the offset instead of dividing by zero at a degenerate tilt', () => {
    expect(sectionOffsetFromTiltedDrag(4, 2, FRONT, { pitch: 0, yaw: 0 })).toBeCloseTo(6, 12)
  })
})
