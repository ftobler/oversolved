import * as THREE from 'three'

// Cosine of the angle between the cursor ray and the plane normal below which
// the projection is treated as edge-on. See projectCursorToSketchPlane.
const MIN_PLANE_INCIDENCE = 1e-6

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
  // Three.js refuses only an exactly-parallel ray (`denominator === 0`), which
  // floating point rarely produces for a "parallel" camera. A ray a hair off
  // edge-on instead returns a finite point at distance/sin(angle), so a tiny
  // mid-drag camera nudge could commit a vertex far outside the document. Treat
  // any ray within this incidence of the plane as edge-on and refuse it.
  const incidence = Math.abs(raycaster.ray.direction.dot(plane.normal))
  if (incidence < MIN_PLANE_INCIDENCE) return null
  return raycaster.ray.intersectPlane(plane, out)
}
