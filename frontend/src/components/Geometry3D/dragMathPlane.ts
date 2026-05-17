import * as THREE from 'three'

/**
 * Math-only drag plane recipe (replaces the old invisible mesh + raycast).
 *
 * Given a sketch group's world transform, build a `THREE.Plane` aligned with
 * the sketch's local XY plane. The plane is rebuilt fresh on every pointer
 * move (cheap; no allocations land on the GPU), so it always tracks the
 * sketch group even if a parent transform changes mid-drag.
 */
export function buildSketchWorldPlane(
  group: THREE.Object3D,
  out: THREE.Plane = new THREE.Plane(),
): THREE.Plane {
  const worldQuat = new THREE.Quaternion()
  group.getWorldQuaternion(worldQuat)
  const worldPos = new THREE.Vector3()
  group.getWorldPosition(worldPos)
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(worldQuat)
  out.setFromNormalAndCoplanarPoint(normal, worldPos)
  return out
}

/**
 * Project an NDC cursor onto the sketch plane and return the world-space
 * intersection point. Returns null when the cursor ray is parallel to the
 * plane (e.g. camera looking edge-on).
 */
export function projectCursorToSketchPlane(
  camera: THREE.Camera,
  group: THREE.Object3D,
  ndc: { x: number; y: number },
  out: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 | null {
  const plane = buildSketchWorldPlane(group)
  const raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera)
  return raycaster.ray.intersectPlane(plane, out)
}
