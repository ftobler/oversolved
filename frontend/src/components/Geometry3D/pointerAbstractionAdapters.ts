import * as THREE from 'three'
import { worldToLocal3D } from './coordTransformAdapters'
import { makeSanitizedEvent } from './pointerAbstraction'
import type { SanitizedPointerEvent } from './pointerAbstraction'

export type { SanitizedPointerEvent }

/** End-to-end adapter: R3F pointer event -> sanitized event via Three.js world transform.
 *  Converts the Three.js world hit point to sketch-local 3D, then delegates the off-plane
 *  check and wrapping to the pure makeSanitizedEvent(). Returns null if the ref is not
 *  mounted or the hit is off the sketch plane (|local z| > 1). */
export function sanitizePointerEvent(
  event: { point: THREE.Vector3; clientX: number; clientY: number },
  groupRef: React.RefObject<THREE.Object3D | null>,
): SanitizedPointerEvent | null {
  const local3d = worldToLocal3D(event.point, groupRef)
  if (!local3d) return null
  return makeSanitizedEvent(local3d, [event.clientX, event.clientY])
}
