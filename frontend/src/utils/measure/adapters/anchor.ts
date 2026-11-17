// An assembly anchor pose mapped to a world primitive (assembly frame, mm).
//
// The assembly has no mesh and no face_data per pick: what the solve places at a
// pickable entity is an anchor, a point plus a direction. A cylinder/cone/torus
// anchor therefore becomes an axis with no radius, and a circle anchor a centre
// with no radius, so a single pick states nothing (the extent is not known)
// while every pair rule still works.
import { add, type Vec3 } from '@/utils/vec3'
import type { AnchorPose } from '@/kernel/partBundle'
import { normalize, type Primitive } from '../primitives'

export function anchorPrimitive(anchor: AnchorPose): Primitive | null {
  const point = [...anchor.point] as Vec3
  const dir = normalize(anchor.axis)
  switch (anchor.kind) {
    case 'plane':
      return dir ? { type: 'plane', point, normal: dir, bounded: false } : null
    case 'point':
    case 'sphere':
      // A sphere's centre IS its identity, so it measures as a point.
      return { type: 'point', p: point }
    case 'line':
      // An anchor has no endpoints; the segment is unbounded so the skew-pair
      // minimum distance is not invented from a unit step.
      return dir ? { type: 'line', p0: point, p1: add(point, dir), dir, bounded: false } : null
    case 'cylinder':
      return dir ? { type: 'cylinder', axisPoint: point, axis: dir } : null
    case 'cone':
      return dir ? { type: 'cone', axisPoint: point, axis: dir } : null
    case 'torus':
      return dir ? { type: 'torus', center: point, axis: dir } : null
    case 'circle':
      return dir ? { type: 'circle', center: point, axis: dir } : null
    default:
      return null
  }
}
