import * as THREE from 'three'

/** Orient an object to face the camera in world space, undoing the parent's
 *  world rotation first so the billboard holds even when the object sits under
 *  a rotated group (e.g. a tilted sketch plane). Call from within useFrame. */
export function applyWorldBillboard(obj: THREE.Object3D, camera: THREE.Camera): void {
  const parentQuat = new THREE.Quaternion()
  obj.parent?.getWorldQuaternion(parentQuat)
  obj.quaternion.copy(camera.quaternion).premultiply(parentQuat.invert())
}
