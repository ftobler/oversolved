// The visible cap's material recipe and render order. The stencil technique is
// easy to get subtly wrong (an increment on both sides fills the solid instead
// of the opening), so the operations are pinned here without a GPU.
import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import {
  SECTION_CAP_FILL_ORDER,
  SECTION_CAP_STENCIL_BACK_ORDER,
  SECTION_CAP_STENCIL_FRONT_ORDER,
  buildSectionCapFillMaterial,
  buildSectionCapStencilMaterial,
  placeSectionCapQuad,
} from '@/components/Geometry3D/sectionCaps'
import { getSectionClipPlaneList, resetSectionClippingForTest, setSectionClipPlane } from '@/viewport/sectionClipping'
import { sectionPlaneFromFrame } from '@/viewport/sectionPlane'

describe('section cap materials', () => {
  beforeEach(() => resetSectionClippingForTest())

  it('counts back faces up and front faces down, with no colour or depth', () => {
    const back = buildSectionCapStencilMaterial(THREE.BackSide)
    const front = buildSectionCapStencilMaterial(THREE.FrontSide)

    expect(back.side).toBe(THREE.BackSide)
    expect(back.stencilFail).toBe(THREE.IncrementWrapStencilOp)
    expect(back.stencilZPass).toBe(THREE.IncrementWrapStencilOp)
    expect(front.stencilFail).toBe(THREE.DecrementWrapStencilOp)
    expect(front.stencilZPass).toBe(THREE.DecrementWrapStencilOp)
    for (const material of [back, front]) {
      expect(material.colorWrite).toBe(false)
      expect(material.depthWrite).toBe(false)
      expect(material.depthTest).toBe(false)
      expect(material.clippingPlanes).toBe(getSectionClipPlaneList())
    }
  })

  it('fills only where the count is non-zero, then resets the stencil', () => {
    const fill = buildSectionCapFillMaterial('#88cc88')
    expect(fill.color.getHexString()).toBe('88cc88')
    expect(fill.stencilFunc).toBe(THREE.NotEqualStencilFunc)
    expect(fill.stencilFail).toBe(THREE.ReplaceStencilOp)
    expect(fill.stencilZPass).toBe(THREE.ReplaceStencilOp)
    expect(fill.depthTest).toBe(true)
    expect(fill.depthWrite).toBe(true)
  })

  it('draws the cap after the bodies it fills', () => {
    expect(SECTION_CAP_STENCIL_BACK_ORDER).toBeLessThan(SECTION_CAP_STENCIL_FRONT_ORDER)
    expect(SECTION_CAP_STENCIL_FRONT_ORDER).toBeLessThan(SECTION_CAP_FILL_ORDER)
    // Bodies and their edges draw at the default order (0).
    expect(SECTION_CAP_STENCIL_BACK_ORDER).toBeGreaterThan(0)
  })
})

describe('placeSectionCapQuad', () => {
  beforeEach(() => resetSectionClippingForTest())

  it('puts the quad on the live plane in its parent local frame', () => {
    setSectionClipPlane(sectionPlaneFromFrame({ normal: [0, 0, 1], point: [0, 0, 0] }, 3, false))

    const parent = new THREE.Group()
    parent.position.set(10, 0, 0)
    parent.rotation.y = Math.PI / 2
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1))
    parent.add(quad)
    parent.updateMatrixWorld(true)

    placeSectionCapQuad(quad)
    quad.updateMatrixWorld(true)

    const worldPosition = quad.getWorldPosition(new THREE.Vector3())
    // The plane is z = 3 in world space; the quad is a child of the rotated,
    // translated group, so its local position has to compensate.
    expect(worldPosition.x).toBeCloseTo(0, 9)
    expect(worldPosition.y).toBeCloseTo(0, 9)
    expect(worldPosition.z).toBeCloseTo(3, 9)

    const worldNormal = quad.getWorldDirection(new THREE.Vector3())
    expect(worldNormal.x).toBeCloseTo(0, 9)
    expect(worldNormal.y).toBeCloseTo(0, 9)
    expect(worldNormal.z).toBeCloseTo(1, 9)
  })
})
