// Small plane/point helpers shared by the profile builder and the entity
// matcher. They are pure and OCC-free, so they live here rather than being
// duplicated in the two modules that need them.

import type { PlaneLike } from '../features/shared/planes'
import type { Vec3 } from './primitives'

export const POINT_TOL = 1e-6

/** A uv-plane point lifted to 3D (plane origin + u*x_axis + v*y_axis). */
export function uvTo3d(plane: PlaneLike, uv: number[]): Vec3 {
  const o = plane.origin
  const x = plane.x_axis
  const y = plane.y_axis
  return [
    o[0] + uv[0] * x[0] + uv[1] * y[0],
    o[1] + uv[0] * x[1] + uv[1] * y[1],
    o[2] + uv[0] * x[2] + uv[1] * y[2],
  ]
}

export function pointsMatch(a: number[], b: number[]): boolean {
  return (
    Math.abs(a[0] - b[0]) < POINT_TOL &&
    Math.abs(a[1] - b[1]) < POINT_TOL &&
    Math.abs(a[2] - b[2]) < POINT_TOL
  )
}
