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

/** Extract parent transform from a Three.js group ref and convert world point to sketch-local 2D.
 *  Returns null when the group ref is not mounted or when the local Z is far from the sketch
 *  plane (|z| > 1), which indicates a hit on an HTML overlay rather than geometry. */
export function worldToSketchLocal(
  worldPt: THREE.Vector3,
  groupRef: React.RefObject<THREE.Object3D | null>,
): [number, number] | null {
  const local = worldToLocal3D(worldPt, groupRef)
  if (!local) return null
  if (Math.abs(local[2]) > 1) return null
  return [local[0], local[1]]
}
