// The shared clipping plane: one instance, updated in place, attached only to
// the materials the section is allowed to cut. The reference-geometry rule is
// the important half: sketches, planes, helixes and handles stay whole.
import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import {
  applySectionClipping,
  getSectionClipPlane,
  getSectionClipPlaneList,
  isPointClipped,
  isSectionClippingActive,
  resetSectionClippingForTest,
  setSectionClipPlane,
} from '@/viewport/sectionClipping'
import { sectionPlaneFromFrame } from '@/viewport/sectionPlane'

describe('shared section clipping plane', () => {
  beforeEach(() => {
    resetSectionClippingForTest()
  })

  it('is inert until a plane is published', () => {
    expect(isPointClipped(new THREE.Vector3(0, 0, 5))).toBe(false)
    expect(isSectionClippingActive()).toBe(false)
    expect(getSectionClipPlaneList()).toHaveLength(1)
  })

  it('copies the published plane in place so every material sees the update', () => {
    const before = getSectionClipPlane()
    setSectionClipPlane(sectionPlaneFromFrame({ normal: [0, 0, 1], point: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0] }, 3, false))

    expect(getSectionClipPlane()).toBe(before)
    expect(isSectionClippingActive()).toBe(true)
    expect(before.constant).toBeCloseTo(3, 12)
    expect(getSectionClipPlaneList()).toContain(before)
  })

  it('clips the half three discards (positive signed distance)', () => {
    setSectionClipPlane(sectionPlaneFromFrame({ normal: [0, 0, 1], point: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0] }, 0, false))
    expect(isPointClipped([0, 0, 1])).toBe(true)
    expect(isPointClipped([0, 0, -1])).toBe(false)
  })

  it('flipping moves the clipped half to the other side', () => {
    setSectionClipPlane(sectionPlaneFromFrame({ normal: [0, 0, 1], point: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0] }, 0, true))
    expect(isPointClipped([0, 0, 1])).toBe(false)
    expect(isPointClipped([0, 0, -1])).toBe(true)
  })

  it('clips by the shared plane once the section is tilted', () => {
    const frame = {
      normal: [0, 0, 1] as [number, number, number],
      point: [0, 0, 0] as [number, number, number],
      u: [1, 0, 0] as [number, number, number],
      v: [0, 1, 0] as [number, number, number],
    }
    const tilt = { pitch: 40 * Math.PI / 180, yaw: 0 }
    const plane = sectionPlaneFromFrame(frame, 0, false, tilt)
    setSectionClipPlane(plane)

    // A point just on each side of the drawn plane: the CPU predicate must
    // agree with the plane the materials and the ID layers hand to the GPU.
    // three clips the negative-distance half, and the unflipped section builds
    // the plane with the negated tilted normal, so the removed side is the one
    // the plane's normal points away from.
    const n = plane.normal
    const kept: [number, number, number] = [n.x * 0.5, n.y * 0.5, n.z * 0.5]
    const removed: [number, number, number] = [-n.x * 0.5, -n.y * 0.5, -n.z * 0.5]
    expect(isPointClipped(kept)).toBe(false)
    expect(isPointClipped(removed)).toBe(true)
    expect(plane.distanceToPoint(new THREE.Vector3(...removed))).toBeLessThan(0)
  })

  it('attaches and clears the plane list on a built-in material', () => {
    const material = new THREE.MeshPhysicalMaterial()
    applySectionClipping(material, true)
    expect(material.clippingPlanes).toBe(getSectionClipPlaneList())
    applySectionClipping(material, false)
    expect(material.clippingPlanes).toBeNull()
  })

  it('is idempotent, so a re-render does not force a shader recompile', () => {
    const material = new THREE.ShaderMaterial()
    applySectionClipping(material, true)
    const version = material.version
    applySectionClipping(material, true)
    expect(material.version).toBe(version)
  })
})
