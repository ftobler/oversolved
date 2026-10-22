// The visible cap's material recipe and render-order bands. The stencil
// technique is easy to get subtly wrong (an increment on both sides fills the
// solid instead of the opening), and three sorts the whole scene by renderOrder,
// so each body's three passes must be contiguous or their counts interleave.
import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import {
  SECTION_CAP_BASE_ORDER,
  SECTION_CAP_MAX_BAND,
  buildSectionCapFillMaterial,
  buildSectionCapStencilMaterial,
  placeSectionCapQuad,
  sectionCapRenderOrders,
} from '@/components/Geometry3D/sectionCaps'
import { getSectionClipPlane, getSectionClipPlaneList, resetSectionClippingForTest, setSectionClipPlane } from '@/viewport/sectionClipping'
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
    // The kept side can present the back face of the quad; a FrontSide fill
    // would be culled there and the cut would stay open.
    expect(fill.side).toBe(THREE.DoubleSide)
  })
})

describe('section cap render-order bands', () => {
  it('gives every body three contiguous orders, after the bodies and below highlights', () => {
    const orders = [0, 1, 2, 40].map(sectionCapRenderOrders)
    expect(orders[0]).toEqual([SECTION_CAP_BASE_ORDER, SECTION_CAP_BASE_ORDER + 1, SECTION_CAP_BASE_ORDER + 2])
    expect(orders[1]).toEqual([orders[0][2] + 1, orders[0][2] + 2, orders[0][2] + 3])
    // Strictly increasing across bodies: no interleaving of another body's
    // back pass between this body's count and fill.
    const flat = orders.flat()
    expect(flat).toEqual([...flat].sort((a, b) => a - b))
    expect(new Set(flat).size).toBe(flat.length)
    expect(SECTION_CAP_MAX_BAND).toBeGreaterThan(40)
    expect(orders.at(-1)![2]).toBeLessThan(999)
  })
})

describe('placeSectionCapQuad', () => {
  beforeEach(() => resetSectionClippingForTest())

  it('writes the world matrix on the live plane, without a later scene update', () => {
    setSectionClipPlane(sectionPlaneFromFrame({ normal: [0, 0, 1], point: [0, 0, 0] }, 3, false))
    const plane = getSectionClipPlane()

    const parent = new THREE.Group()
    parent.position.set(10, 0, 0)
    parent.rotation.y = Math.PI / 2
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1))
    parent.add(quad)
    parent.updateMatrixWorld(true)

    placeSectionCapQuad(quad)

    // Read matrixWorld directly: getWorldPosition would recompute it and hide a
    // missing updateMatrixWorld (the one-frame lag this pins).
    const worldPosition = new THREE.Vector3().setFromMatrixPosition(quad.matrixWorld)
    expect(worldPosition.x).toBeCloseTo(0, 9)
    expect(worldPosition.y).toBeCloseTo(0, 9)
    expect(worldPosition.z).toBeCloseTo(3, 9)

    const worldRotation = new THREE.Quaternion().setFromRotationMatrix(quad.matrixWorld)
    const worldNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(worldRotation)
    expect(worldNormal.x).toBeCloseTo(plane.normal.x, 9)
    expect(worldNormal.y).toBeCloseTo(plane.normal.y, 9)
    expect(worldNormal.z).toBeCloseTo(plane.normal.z, 9)
  })
})
