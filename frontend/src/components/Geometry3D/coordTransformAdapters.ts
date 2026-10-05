import * as THREE from 'three'
import { worldToSketchLocalPure } from '@/components/Geometry3D/coordTransform'

/** Extract parent transform from a Three.js group ref and return the hit point in
 *  sketch-local 3D coordinates. Returns null when the group ref is not mounted.
 *  The z component reflects how far the hit is from the sketch plane -- callers can
 *  use it for off-plane detection (see makeSanitizedEvent). */
export function worldToLocal3D(
  worldPt: THREE.Vector3,
  groupRef: React.RefObject<THREE.Object3D | null>,
): [number, number, number] | null {
  const parent = groupRef.current
  if (!parent) return null
  const parentPos = new THREE.Vector3()
  parent.getWorldPosition(parentPos)
  const q = new THREE.Quaternion()
  parent.getWorldQuaternion(q)
  return worldToSketchLocalPure(
    [worldPt.x, worldPt.y, worldPt.z],
    [parentPos.x, parentPos.y, parentPos.z],
    [q.x, q.y, q.z, q.w],
  )
}
