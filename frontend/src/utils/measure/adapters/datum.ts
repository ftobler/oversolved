// A datum plane pick (`@<featureId>`) mapped to a world plane. The solved
// feature result carries the plane frame; a plane with no solve yet is
// unresolvable rather than a guess from the document row.
import type { Vec3 } from '@/utils/vec3'
import { normalize, type Primitive } from '../primitives'

interface DatumSolve {
  plane?: {
    origin: Vec3
    normal: Vec3
    x_axis: Vec3
    y_axis: Vec3
  }
}

export function datumPrimitive(
  featureId: string,
  solveResults: Record<string, unknown> | undefined,
): Primitive | null {
  const plane = (solveResults?.[featureId] as DatumSolve | undefined)?.plane
  if (!plane) return null
  const normal = normalize(plane.normal)
  if (!normal) return null
  return { type: 'plane', point: [...plane.origin] as Vec3, normal, bounded: false }
}
