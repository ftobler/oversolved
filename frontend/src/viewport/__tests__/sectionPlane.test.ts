import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  applySectionTiltSwing,
  builtinSectionFrame,
  clampSectionTilt,
  offsetFramePoint,
  resolveSectionFrame,
  sectionFrameKey,
  sectionOffsetFromDrag,
  sectionOffsetFromTiltedDrag,
  sectionOutlineBounds,
  sectionOutlineRect,
  sectionPlaneFromFrame,
  tiltedSectionFrame,
} from '@/viewport/sectionPlane'
import { normalToFrame } from '@/kernel/types3d'
import type { PartFeature, PartResult } from '@/types/cad'
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

// The cosine of a tilt's total angle, the same quantity the clamp bounds.
function reach(tilt: { pitch: number; yaw: number }): number {
  return Math.cos(tilt.pitch) * Math.cos(tilt.yaw)
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
    // The tilted in-plane axes stay right-handed, and the yawed u is the
    // pitch axis carried around the pitched v.
    expectVec(cross(tilted.u, tilted.v), tilted.normal)
    expectVec(tilted.v, pitchedV)
    expect(Math.hypot(...tilted.u)).toBeCloseTo(1, 12)
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

  it('pulls a both-axes-out request back along its own ratio, idempotently', () => {
    // Both angles are past the limit AND their product is past it too, the case
    // the per-axis clamp missed: nothing may snap to zero here.
    const far = { pitch: 100 * DEG, yaw: 200 * DEG }
    const clamped = clampSectionTilt(far)
    expect(Math.acos(reach(clamped))).toBeLessThanOrEqual(85 * DEG + 1e-9)
    expect(clamped.pitch).toBeGreaterThan(60 * DEG)
    expect(clamped.yaw).toBeGreaterThan(60 * DEG)
    // The store and the geometry both clamp, so a second pass must not move it.
    const again = clampSectionTilt(clamped)
    expect(again.pitch).toBe(clamped.pitch)
    expect(again.yaw).toBe(clamped.yaw)
  })

  it('holds a drag at the limit and reports only the swing the plane took', () => {
    // A pitch drag from a corner where the yaw already spends the whole cone
    // holds instead of snapping (a hair of float noise is fine).
    const corner = { pitch: 0, yaw: 85 * DEG }
    const held = applySectionTiltSwing(corner, 'pitch', 20 * DEG)
    expect(held.tilt.pitch).toBeLessThan(1e-6)
    expect(held.tilt.yaw).toBeCloseTo(corner.yaw, 12)
    expect(held.swing).toBeLessThan(1e-6)
    // From an inside pose, the drag lands at the limit, not past it, and the
    // reported swing is what was actually applied.
    const inside = { pitch: 0, yaw: 50 * DEG }
    const taken = applySectionTiltSwing(inside, 'pitch', 90 * DEG)
    expect(reach(taken.tilt)).toBeCloseTo(Math.cos(85 * DEG), 9)
    expect(taken.swing).toBeGreaterThan(0)
    expect(taken.swing).toBeLessThan(90 * DEG)
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

describe('sectionOutlineRect', () => {
  const BOUNDS = { min: [0, 0, 0] as Vec3, max: [100, 50, 20] as Vec3 }

  it('spans the projected bounds plus a tenth of the larger side', () => {
    const rect = sectionOutlineRect(BOUNDS, [0, 0, 0], [1, 0, 0], [0, 1, 0])!
    // s is 0..100 and t is 0..50 relative to the anchor; the margin is 10% of
    // the larger side.
    expectVec(rect.center, [50, 25, 0])
    expect(rect.halfU).toBeCloseTo(60, 12)
    expect(rect.halfV).toBeCloseTo(35, 12)
  })

  it('stretches to include an anchor outside the bounds', () => {
    const anchor: Vec3 = [-200, 0, 0]
    const rect = sectionOutlineRect(BOUNDS, anchor, [1, 0, 0], [0, 1, 0])!
    // The model reaches s = 200..300 from that anchor and the anchor is s = 0,
    // so the rectangle is centred between them and its margin is 10% of 300.
    expectVec(rect.center, [-50, 25, 0])
    expect(rect.halfU).toBeCloseTo(180, 12)
    expect(rect.halfV).toBeCloseTo(55, 12)
    // The arrow's base is on the plane, inside the drawn rectangle.
    expect(Math.abs(0 - rect.center[0])).toBeLessThanOrEqual(rect.halfU)
  })

  it('gives a flat plate a border on both in-plane axes', () => {
    // On Top the plate's thin Y axis is the normal, so both projected extents
    // come from the plate's own size.
    const { u, v } = builtinSectionFrame('top')
    const rect = sectionOutlineRect({ min: [0, 0, 0], max: [100, 0.01, 100] }, [0, 0, 0], u, v)!
    expect(rect.halfU).toBeCloseTo(60, 12)
    expect(rect.halfV).toBeCloseTo(60, 12)
  })

  it('keeps the one unit margin floor when both extents are near zero', () => {
    const { u, v } = builtinSectionFrame('top')
    const rect = sectionOutlineRect({ min: [0, 0, 0], max: [0.2, 0, 0.2] }, [0, 0, 0], u, v)!
    expect(rect.halfU).toBeCloseTo(1.1, 12)
    expect(rect.halfV).toBeCloseTo(1.1, 12)
  })

  it('returns null without geometry, so the caller keeps its default', () => {
    expect(sectionOutlineRect(null, [0, 0, 0], [1, 0, 0], [0, 1, 0])).toBeNull()
  })

  it('projects a cube onto a 45 degree tilted basis at the corner reach', () => {
    const c = Math.SQRT1_2
    const u: Vec3 = [c, c, 0]
    const v: Vec3 = [-c, c, 0]
    const rect = sectionOutlineRect({ min: [0, 0, 0], max: [10, 10, 10] }, [5, 5, 5], u, v)!
    // Every corner is 5 units from the centre on each axis, so each projection
    // reaches 5*sqrt2: the 45 degree corner reach, not the axis-aligned 5. The
    // eight corners are an upper bound for a shape that does not fill its box.
    const reach = 5 * Math.SQRT2
    const margin = Math.max(0.1 * 2 * reach, 1)
    expectVec(rect.center, [5, 5, 5])
    expect(rect.halfU).toBeCloseTo(reach + margin, 12)
    expect(rect.halfV).toBeCloseTo(reach + margin, 12)
  })
})

describe('sectionOutlineBounds', () => {
  function solvedPart(id: string, min: Vec3, max: Vec3, createdBy = 'extrude_1'): PartResult {
    return {
      id,
      created_by: createdBy,
      modified_by: [],
      mesh: {
        vertices: [
          [min[0], min[1], min[2]],
          [max[0], max[1], max[2]],
        ],
        faces: [],
      },
    }
  }

  const NO_VISIBILITY = {
    features: undefined,
    visibleParts: undefined,
    visibleFeatures: undefined,
  }

  it('unions every drawn part', () => {
    const bounds = sectionOutlineBounds({
      ...NO_VISIBILITY,
      parts: { a: solvedPart('a', [0, 0, 0], [10, 10, 10]), b: solvedPart('b', [20, 0, 0], [30, 5, 5]) },
    })
    expect(bounds).toEqual({ min: [0, 0, 0], max: [30, 10, 10] })
  })

  it('skips a hidden part while another one is drawn', () => {
    const parts = { a: solvedPart('a', [0, 0, 0], [1000, 10, 10]), b: solvedPart('b', [0, 0, 0], [10, 10, 10]) }
    const bounds = sectionOutlineBounds({
      parts, features: undefined, visibleParts: new Set(['b']), visibleFeatures: undefined,
    })
    expect(bounds).toEqual({ min: [0, 0, 0], max: [10, 10, 10] })
  })

  it('still measures every part when the user hid them all', () => {
    const parts = { a: solvedPart('a', [0, 0, 0], [1000, 10, 10]), b: solvedPart('b', [0, 0, 0], [10, 10, 10]) }
    const bounds = sectionOutlineBounds({
      parts, features: undefined, visibleParts: new Set(), visibleFeatures: undefined,
    })
    expect(bounds).toEqual({ min: [0, 0, 0], max: [1000, 10, 10] })
  })

  it('follows a hidden creating feature', () => {
    const parts = {
      a: solvedPart('a', [0, 0, 0], [1000, 10, 10], 'extrude_1'),
      b: solvedPart('b', [0, 0, 0], [10, 10, 10], 'extrude_2'),
    }
    const features = [{ id: 'extrude_1' }, { id: 'extrude_2' }] as PartFeature[]
    const bounds = sectionOutlineBounds({
      parts, features, visibleParts: undefined, visibleFeatures: new Set(['extrude_2']),
    })
    expect(bounds).toEqual({ min: [0, 0, 0], max: [10, 10, 10] })
  })

  it('is null when no part has a mesh, the sketch-only case', () => {
    expect(sectionOutlineBounds({ ...NO_VISIBILITY, parts: {} })).toBeNull()
    expect(sectionOutlineBounds({
      ...NO_VISIBILITY,
      parts: { a: { id: 'a', created_by: 'sketch_1', modified_by: [] } },
    })).toBeNull()
  })
})
