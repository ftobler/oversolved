import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  builtinSectionFrame,
  offsetFramePoint,
  resolveSectionFrame,
  sectionOffsetFromDrag,
  sectionPlaneFromFrame,
  sectionSourceLabel,
} from '@/viewport/sectionPlane'

const NO_SOURCES = {
  planeTransform: () => null,
  faceFrame: () => null,
}

describe('builtin section planes', () => {
  it('names the same normals as the builtin sketch planes', () => {
    expect(builtinSectionFrame('front').normal).toEqual([0, 0, 1])
    expect(builtinSectionFrame('top').normal).toEqual([0, 1, 0])
    expect(builtinSectionFrame('right').normal).toEqual([1, 0, 0])
    for (const frame of [builtinSectionFrame('front'), builtinSectionFrame('top'), builtinSectionFrame('right')]) {
      expect(frame.point).toEqual([0, 0, 0])
    }
  })

  it('labels the current source for the dropdown', () => {
    expect(sectionSourceLabel({ kind: 'builtin', id: 'front' })).toBe('Front')
    expect(sectionSourceLabel({ kind: 'query', query: '?04;abcd' })).toContain('?04;abcd')
  })
})

describe('sectionPlaneFromFrame', () => {
  const frame = { normal: [0, 0, 1] as [number, number, number], point: [0, 0, 0] as [number, number, number] }

  it('builds a plane through the point with the frame normal', () => {
    const plane = sectionPlaneFromFrame(frame, 0, false)
    expect(plane.normal.toArray()).toEqual([0, 0, 1])
    expect(plane.constant).toBeCloseTo(0, 12)
    expect(plane.distanceToPoint(new THREE.Vector3(0, 0, 2))).toBeCloseTo(2, 12)
  })

  it('moves along the normal with the offset', () => {
    const plane = sectionPlaneFromFrame(frame, 4, false)
    expect(plane.constant).toBeCloseTo(-4, 12)
    // The plane now passes through z = 4.
    expect(plane.distanceToPoint(new THREE.Vector3(0, 0, 4))).toBeCloseTo(0, 12)
  })

  it('flipped negates both the normal and the constant', () => {
    const upright = sectionPlaneFromFrame(frame, 4, false)
    const flipped = sectionPlaneFromFrame(frame, 4, true)
    expect(flipped.normal.toArray()).toEqual([-0, -0, -1])
    expect(flipped.constant).toBeCloseTo(-upright.constant, 12)
    // Same plane, other half kept.
    expect(flipped.distanceToPoint(new THREE.Vector3(0, 0, 4))).toBeCloseTo(0, 12)
    expect(Math.sign(flipped.distanceToPoint(new THREE.Vector3(0, 0, 8))))
      .toBe(-Math.sign(upright.distanceToPoint(new THREE.Vector3(0, 0, 8))))
  })

  it('moves the point helper along the normal', () => {
    expect(offsetFramePoint({ normal: [0, 1, 0], point: [1, 2, 3] }, 5)).toEqual([1, 7, 3])
  })
})

describe('resolveSectionFrame', () => {
  it('resolves a builtin without asking the scene', () => {
    expect(resolveSectionFrame({ kind: 'builtin', id: 'top' }, NO_SOURCES)).toEqual({
      normal: [0, 1, 0],
      point: [0, 0, 0],
    })
  })

  it('resolves a user plane from its solved transform', () => {
    const frame = resolveSectionFrame({ kind: 'query', query: 'Plane1' }, {
      planeTransform: q => q === 'Plane1'
        ? { rotation: [1, 0, 0, 0, 0, -1, 0, 1, 0], origin: [1, 2, 3] }
        : null,
      faceFrame: () => null,
    })
    expect(frame).not.toBeNull()
    expect(frame!.normal).toEqual([0, 1, 0])
    expect(frame!.point).toEqual([1, 2, 3])
  })

  it('resolves a planar face from its frame when no plane transform matches', () => {
    const frame = resolveSectionFrame({ kind: 'query', query: '?face' }, {
      planeTransform: () => null,
      faceFrame: q => q === '?face' ? { normal: [0, 0, 2], point: [4, 5, 6] } : null,
    })
    // The normal is normalized so offset means world distance.
    expect(frame).toEqual({ normal: [0, 0, 1], point: [4, 5, 6] })
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
