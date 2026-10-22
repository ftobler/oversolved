// The visible section cap: the solid-looking cut face.
//
// This is the classic stencil cap. For one body, back faces increment a stencil
// count and front faces decrement it, both clipped by the section plane; the cap
// quad then draws only where the count is non-zero, i.e. where the plane passes
// through the solid. Doing it per body (the stencil is cleared before each
// body's passes) is what lets two overlapping assembly parts each get their own
// flat fill instead of one colour winning the union.
//
// The pass order is deliberately after the bodies (render order 150..152): the
// cap depth-tests against the kept front surfaces, so it fills only the opening
// and is hidden where the solid is still in front of it.
import * as THREE from 'three'
import { getSectionClipPlane, getSectionClipPlaneList } from '@/viewport/sectionClipping'

export const SECTION_CAP_STENCIL_BACK_ORDER = 150
export const SECTION_CAP_STENCIL_FRONT_ORDER = 151
export const SECTION_CAP_FILL_ORDER = 152

// Large enough to cover any model the viewport frames. The stencil decides
// where the quad paints, so the excess area is never visible.
export const SECTION_CAP_SIZE = 10000

const CAP_NORMAL = new THREE.Vector3(0, 0, 1)

export function buildSectionCapStencilMaterial(side: THREE.Side): THREE.MeshBasicMaterial {
  const operation = side === THREE.BackSide
    ? THREE.IncrementWrapStencilOp
    : THREE.DecrementWrapStencilOp
  return new THREE.MeshBasicMaterial({
    side,
    // A count pass owns no colour and no depth: it only writes the stencil.
    colorWrite: false,
    depthWrite: false,
    depthTest: false,
    stencilWrite: true,
    stencilRef: 0,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilFail: operation,
    stencilZFail: operation,
    stencilZPass: operation,
    // The count must only hear the kept half, or the removed geometry would
    // cancel the opening out.
    clippingPlanes: getSectionClipPlaneList(),
  })
}

export function buildSectionCapFillMaterial(color: string): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: true,
    stencilWrite: true,
    stencilRef: 0,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.ReplaceStencilOp,
    stencilZFail: THREE.ReplaceStencilOp,
    stencilZPass: THREE.ReplaceStencilOp,
  })
}

const scratchPoint = new THREE.Vector3()
const scratchInverse = new THREE.Matrix4()
const scratchParentRotation = new THREE.Quaternion()
const scratchNormalRotation = new THREE.Quaternion()

/**
 * Put a cap quad on the live section plane, expressed in its parent's local
 * frame. The quad is a child of the body's group, which carries the assembly
 * pose, so the world-space plane has to be pulled back through that pose.
 */
export function placeSectionCapQuad(quad: THREE.Mesh): void {
  const parent = quad.parent
  if (!parent) return
  const plane = getSectionClipPlane()
  scratchPoint.copy(plane.normal).multiplyScalar(-plane.constant)
  parent.updateWorldMatrix(true, false)
  scratchInverse.copy(parent.matrixWorld).invert()
  quad.position.copy(scratchPoint).applyMatrix4(scratchInverse)
  scratchParentRotation.setFromRotationMatrix(parent.matrixWorld).invert()
  scratchNormalRotation.setFromUnitVectors(CAP_NORMAL, plane.normal)
  quad.quaternion.copy(scratchParentRotation).multiply(scratchNormalRotation)
  quad.updateMatrix()
}
