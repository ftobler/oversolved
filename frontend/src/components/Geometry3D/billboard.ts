import * as THREE from 'three'

// Scratch parent rotation, reused across calls. This runs once per billboarded
// object per frame from useFrame, so a fresh Quaternion here is per-frame garbage.
const _parentQuat = new THREE.Quaternion()

/** Orient an object to face the camera in world space, undoing the parent's
 *  world rotation first so the billboard holds even when the object sits under
 *  a rotated group (e.g. a tilted sketch plane). Call from within useFrame. */
export function applyWorldBillboard(obj: THREE.Object3D, camera: THREE.Camera): void {
  // A parentless object has no parent rotation to undo; copying directly also
  // keeps the scratch quaternion from leaking a previous call's rotation.
  if (!obj.parent) {
    obj.quaternion.copy(camera.quaternion)
    return
  }
  obj.parent.getWorldQuaternion(_parentQuat)
  obj.quaternion.copy(camera.quaternion).premultiply(_parentQuat.invert())
}
