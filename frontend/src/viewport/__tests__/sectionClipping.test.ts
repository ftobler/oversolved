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
  resetSectionClippingForTest,
  sectionClippingPlanes,
  setSectionClipPlane,
} from '@/viewport/sectionClipping'
import { sectionPlaneFromFrame } from '@/viewport/sectionPlane'

describe('shared section clipping plane', () => {
  beforeEach(() => {
    resetSectionClippingForTest()
  })

  it('is inert until a plane is published', () => {
    expect(isPointClipped(new THREE.Vector3(0, 0, 5))).toBe(false)
    expect(sectionClippingPlanes()).toBeNull()
    expect(getSectionClipPlaneList()).toHaveLength(1)
  })

  it('copies the published plane in place so every material sees the update', () => {
    const before = getSectionClipPlane()
    setSectionClipPlane(sectionPlaneFromFrame({ normal: [0, 0, 1], point: [0, 0, 0] }, 3, false))

    expect(getSectionClipPlane()).toBe(before)
    expect(before.constant).toBeCloseTo(-3, 12)
    expect(sectionClippingPlanes()).toContain(before)
  })

  it('clips the half three discards (positive signed distance)', () => {
    setSectionClipPlane(sectionPlaneFromFrame({ normal: [0, 0, 1], point: [0, 0, 0] }, 0, false))
    expect(isPointClipped([0, 0, 1])).toBe(true)
    expect(isPointClipped([0, 0, -1])).toBe(false)
  })

  it('flipping moves the clipped half to the other side', () => {
    setSectionClipPlane(sectionPlaneFromFrame({ normal: [0, 0, 1], point: [0, 0, 0] }, 0, true))
    expect(isPointClipped([0, 0, 1])).toBe(false)
    expect(isPointClipped([0, 0, -1])).toBe(true)
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

  it('never hands the plane to a reference material unless the caller asks', () => {
    setSectionClipPlane(sectionPlaneFromFrame({ normal: [0, 1, 0], point: [0, 0, 0] }, 0, false))
    // A sketch line, a reference plane and a dimension label are not clipped:
    // they are what the user reads the cut against.
    for (const material of [
      new THREE.LineBasicMaterial(),
      new THREE.MeshBasicMaterial(),
      new THREE.SpriteMaterial(),
    ]) {
      expect(material.clippingPlanes).toBeNull()
    }
  })
})
