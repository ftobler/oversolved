import * as THREE from 'three'
import { isPointClipped } from '@/viewport/sectionClipping'

// Where a right-drag orbit turns around: the point of the body under the
// cursor, read once at button-down.
//
// The ID buffer is the pick source for selection, but it names the entity and
// not the depth, so the pivot needs its own read. One raycast against the body
// surfaces is enough and costs nothing at button-down frequency. Meshes opt in
// with `userData.orbitPivot`, which is how the body surface tags itself; planes,
// sketches, dimension helpers and the orientation cube stay out of the pick.
// Only drawn bodies count: a hidden group (rollback, per-body hide) must not
// lend its depth to a drag.

export interface ViewportRect {
  left: number
  top: number
  width: number
  height: number
}

/** Client pixels to clip space. Null layout (jsdom, a detached canvas) is a miss. */
export function pointerToNdc(
  rect: ViewportRect,
  clientX: number,
  clientY: number,
  out: THREE.Vector2 = new THREE.Vector2(),
): THREE.Vector2 | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null
  return out.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  )
}

/** Drawn in the scene: the object and every ancestor are visible. */
export function isShownInScene(object: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (!node.visible) return false
  }
  return true
}

/**
 * The world point of the nearest drawn body under the cursor, or null for a
 * miss. The scene's matrices are refreshed first: the read happens on a pointer
 * event, and a demand-rendered scene may not have drawn the last transform yet.
 */
export function pickPivotPoint(
  camera: THREE.Camera,
  scene: THREE.Scene,
  rect: ViewportRect,
  clientX: number,
  clientY: number,
): THREE.Vector3 | null {
  const ndc = pointerToNdc(rect, clientX, clientY)
  if (!ndc) return null

  const targets: THREE.Object3D[] = []
  scene.traverse(object => {
    if (object.userData.orbitPivot === true && isShownInScene(object)) targets.push(object)
  })
  if (targets.length === 0) return null

  scene.updateMatrixWorld(true)
  const raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(ndc, camera)
  // The mesh raycast sees the whole solid, including the half the section
  // removed. Turn about the first point that is actually still drawn.
  const hit = raycaster.intersectObjects(targets, false).find(candidate => !isPointClipped(candidate.point))
  return hit ? hit.point.clone() : null
}
