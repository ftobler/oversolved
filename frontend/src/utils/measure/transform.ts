// Carry a world primitive into another rigid pose.
//
// The part editor resolves a pick in the solve frame and measures there. The
// assembly resolves a pick in the frame the bundle and its anchors were baked
// at, which is one solve behind whatever the viewport is drawing while a
// committed drag settles. Applying the same relative pose to the primitive is
// what keeps the readout and the highlighted geometry in one frame.
//
// Points move by the full transform and directions by the rotation alone: a
// normal, an axis and an edge direction are not positions, and translating one
// would tilt a parallel pair into a fake skew. Radius, sweep and length are
// rigid invariants and are carried through untouched.
import type { Transform3D } from '@/types/cad'
import { rotateVector, transformQuat, type Vec3 } from '@/utils/transform3d'
import type { Primitive } from './primitives'

export function transformMeasurePoint(p: Vec3, pose: Transform3D): Vec3 {
  const r = rotateVector(transformQuat(pose), p)
  return [r[0] + pose.tx, r[1] + pose.ty, r[2] + pose.tz]
}

export function transformMeasureDirection(v: Vec3, pose: Transform3D): Vec3 {
  return rotateVector(transformQuat(pose), v)
}

export function transformPrimitive(primitive: Primitive, pose: Transform3D): Primitive {
  switch (primitive.type) {
    case 'point':
      return { ...primitive, p: transformMeasurePoint(primitive.p, pose) }
    case 'line':
      return {
        ...primitive,
        p0: transformMeasurePoint(primitive.p0, pose),
        p1: transformMeasurePoint(primitive.p1, pose),
        dir: transformMeasureDirection(primitive.dir, pose),
      }
    case 'circle':
      return {
        ...primitive,
        center: transformMeasurePoint(primitive.center, pose),
        axis: transformMeasureDirection(primitive.axis, pose),
      }
    case 'ellipse':
      return {
        ...primitive,
        center: transformMeasurePoint(primitive.center, pose),
        axis: transformMeasureDirection(primitive.axis, pose),
      }
    case 'plane':
      return {
        ...primitive,
        point: transformMeasurePoint(primitive.point, pose),
        normal: transformMeasureDirection(primitive.normal, pose),
      }
    case 'cylinder':
      return {
        ...primitive,
        axisPoint: transformMeasurePoint(primitive.axisPoint, pose),
        axis: transformMeasureDirection(primitive.axis, pose),
      }
    case 'sphere':
      return { ...primitive, center: transformMeasurePoint(primitive.center, pose) }
    case 'cone':
      return {
        ...primitive,
        axisPoint: transformMeasurePoint(primitive.axisPoint, pose),
        axis: transformMeasureDirection(primitive.axis, pose),
      }
    case 'torus':
      return {
        ...primitive,
        center: transformMeasurePoint(primitive.center, pose),
        axis: transformMeasureDirection(primitive.axis, pose),
      }
    case 'opaque':
    case 'solid':
      // A class-unknown pick names no geometry, and a whole body is measured by
      // the kernel in the pose the request carries, not from this primitive.
      return primitive
  }
}
