// Plane math shared by the leaf feature solvers. Python distinguishes a
// Frame3D object from a plain plane dict via isinstance, but the two branches
// compute identical geometry. In TS both satisfy [[PlaneLike]], so the branch
// collapses to one path.

import type { Body } from '../../types3d'
import type { Repository } from '../../query'
import { resolveBarePlaneId } from '../../solverConstants'
import type { Vec3 } from '@/utils/vec3'

/** A plane as either a Frame3D or a plain `{origin, x_axis, y_axis, normal}` dict. */
export interface PlaneLike {
  origin: number[]
  x_axis: number[]
  y_axis: number[]
  normal: number[]
}

/** A plane reduced to what a half-space or a mirror needs: a point and a unit normal. */
export interface ResolvedPlane {
  origin: Vec3
  normal: Vec3
}

type Dict = Record<string, unknown>

/**
 * Resolve a plane-shaped pick to an origin and a unit normal.
 *
 * Accepts every spelling the plane vocabulary allows: a builtin plane feature
 * ref or bare name (Front/Top/Right), a datum-plane feature ref, and a flat-face
 * or plane geometry record from the repo. `leaf` names the calling feature in
 * every failure, so a bad pick reads as the row the user was editing.
 *
 * The normal is normalized here once, so a caller that only needs the direction
 * (mirror, half-space) never has to re-check its length.
 */
export function resolvePlaneRef(
  globalRepo: Repository,
  query: string,
  bodyStore: Record<string, Body>,
  leaf: string,
): ResolvedPlane {
  // A bare builtin name is a UI spelling, not a repo key: the repo holds
  // `builtin_plane_top`, so translate before asking it anything.
  const bareId = resolveBarePlaneId(query) ?? resolveBarePlaneId(query.replace(/^@/, ''))
  const lookup = bareId !== null ? '@' + bareId : query
  const planeData = globalRepo.query(lookup, null, bodyStore) as Dict | null
  if (planeData === null) throw new Error(`${leaf}: plane not found: ${JSON.stringify(query)}`)

  let origin: number[]
  let normal: number[]
  if ('x_axis' in planeData && 'normal' in planeData && 'origin' in planeData && !('type' in planeData)) {
    origin = planeData.origin as number[]
    normal = planeData.normal as number[]
  } else if (planeData.type === 'flatface' || planeData.type === 'plane') {
    origin = (planeData.origin as number[]) ?? [0, 0, 0]
    normal = (planeData.normal as number[]) ?? [0, 0, 1]
  } else {
    throw new Error(`${leaf}: plane query did not resolve to a plane: ${JSON.stringify(query)}`)
  }

  const length = Math.hypot(normal[0], normal[1], normal[2])
  if (!(length > 1e-10)) {
    throw new Error(`${leaf}: plane normal must be a non-zero vector`)
  }
  return {
    origin: [origin[0], origin[1], origin[2]],
    normal: [normal[0] / length, normal[1] / length, normal[2] / length],
  }
}

/** Transform 2D sketch coords to 3D world space (mirrors `_sketch_to_world_2d`). */
export function sketchToWorld2d(xy: number[], plane: PlaneLike): number[] {
  const [u, v] = xy
  return [
    plane.origin[0] + u * plane.x_axis[0] + v * plane.y_axis[0],
    plane.origin[1] + u * plane.x_axis[1] + v * plane.y_axis[1],
    plane.origin[2] + u * plane.x_axis[2] + v * plane.y_axis[2],
  ]
}

/**
 * True when two sketch planes are the same plane: same normal direction, same
 * offset along it, and same in-plane rotation, within the world vertex-merge
 * tolerance. Two sketches on one datum plane are a legitimate multi-sketch
 * profile; two on different planes are not -- every loop is lifted through the
 * FIRST plane's frame, so the second profile silently builds in the wrong place.
 */
export function samePlane(a: PlaneLike, b: PlaneLike, tol = 1e-5): boolean {
  const [an, bn] = [a.normal as number[], b.normal as number[]]
  const d = an[0] * bn[0] + an[1] * bn[1] + an[2] * bn[2]
  if (Math.abs(d - 1) > 1e-6) return false
  const ao = a.origin as number[]
  const bo = b.origin as number[]
  const off = (bo[0] - ao[0]) * an[0] + (bo[1] - ao[1]) * an[1] + (bo[2] - ao[2]) * an[2]
  if (Math.abs(off) > tol) return false
  // A second sketch's loop coords are relative to ITS frame; the feature lifts
  // them through the FIRST frame, so the in-plane rotation must match too.
  // y_axis follows from normal and x_axis, so comparing x_axis is enough.
  const ax = a.x_axis as number[]
  const bx = b.x_axis as number[]
  const r = ax[0] * bx[0] + ax[1] * bx[1] + ax[2] * bx[2]
  return Math.abs(r - 1) <= 1e-6
}
