import * as THREE from 'three'

/** Transform a 3D world point into sketch-local 2D coordinates by applying the
 *  inverse of the sketch group's world transform.
 *
 *  Returns null when the group ref is not mounted or when the world Z is far from
 *  the sketch plane (> 1 unit), which indicates a hit on an HTML overlay rather
 *  than the sketch geometry itself. */
export function worldToSketchLocal(
  worldPt: THREE.Vector3,
  groupRef: React.RefObject<THREE.Object3D | null>,
): [number, number] | null {
  const parent = groupRef.current
  if (!parent) return null
  if (Math.abs(worldPt.z) > 1) return null
  const parentPos = new THREE.Vector3()
  parent.getWorldPosition(parentPos)
  const q = new THREE.Quaternion()
  parent.getWorldQuaternion(q)
  const local = worldPt.clone().sub(parentPos).applyQuaternion(q.invert())
  return [local.x, local.y]
}
