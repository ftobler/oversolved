import type { PlaneTransform } from '@/types/cad'

/**
 * Stable string key for a plane transform (rotation + origin) so memoized
 * registration hooks re-run when the plane actually changes, not merely when
 * the prop reference shifts.
 */
export function planeTransformKey(planeTransform: PlaneTransform | undefined): string {
  if (!planeTransform) return 'identity'
  return planeTransform.rotation.join(',') + '|' + planeTransform.origin.join(',')
}
