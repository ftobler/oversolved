// Plane math shared by the leaf feature solvers. Python distinguishes a
// Frame3D object from a plain plane dict via isinstance, but the two branches
// compute identical geometry. In TS both satisfy [[PlaneLike]], so the branch
// collapses to one path.

import type { Body } from '../../types3d'
import type { Repository } from '../../query'
import { resolveBarePlaneId } from '../../solverConstants'
import { dot, sub, type Vec3 } from '@/utils/vec3'

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

/** The plane-shaped subset a repo record may carry; every field is optional
 *  because a non-plane record (a point, a body) reaches the same lookup. */
export interface PlaneRecord {
  origin?: number[]
  normal?: number[]
  x_axis?: number[]
  y_axis?: number[]
  type?: string
}

// The accepted spellings, printed in a leaf refusal so one message names the
// fix. The drive boundary prints its own document-aware list
// (`planeTargetProblem` in mutationValues), because it can also list the
// document's plane ids.
const PLANE_REF_SPELLINGS =
  '@builtin_plane_front, @builtin_plane_top, @builtin_plane_right, '
  + 'the bare names Front/Top/Right (case-sensitive), @<planeId>, '
  + 'or a "?" flat-face query from select'

// A repo record is either a bare frame (`{origin, x_axis, y_axis, normal}`, no
// tag) or a tagged plane/flatface entry. Sharing this predicate keeps the
// record check and resolvePlaneRef's branch from drifting apart.
function isFrameRecord(record: PlaneRecord): boolean {
  return 'x_axis' in record && 'normal' in record && 'origin' in record && !('type' in record)
}

/**
 * Resolve a plane-pick ref to the repository record behind it.
 *
 * This is the one spelling path: a caller that needs the full frame (the
 * datum-plane leaf, which must take the parent's axes) and one that needs
 * origin plus normal (mirror, split) read the ref the same way. A bare builtin
 * name is translated first, so `Top` resolves where the repo holds
 * `builtin_plane_top`; a bare document plane id then reads from the elements,
 * as the sketch rows do, so a user plane id cannot be shadowed by the builtin
 * capitalisation rule. `leaf` names the calling feature in every failure.
 *
 * A record that is not plane-shaped is refused here rather than defaulted by
 * the caller: the plane leaf's `planeAxes` would otherwise read a point or body
 * record as the world XY frame, the silent fallback this path exists to remove.
 */
export function resolvePlaneRecord(
  globalRepo: Repository,
  query: string,
  bodyStore: Record<string, Body> | null,
  leaf: string,
): PlaneRecord {
  const planeData = lookupPlaneRecord(globalRepo, query, bodyStore)
  if (planeData === null) {
    throw new Error(
      `${leaf}: plane not found: ${JSON.stringify(query)}; use one of ${PLANE_REF_SPELLINGS}`,
    )
  }
  if (!isFrameRecord(planeData) && planeData.type !== 'flatface' && planeData.type !== 'plane') {
    throw new Error(`${leaf}: plane query did not resolve to a plane: ${JSON.stringify(query)}`)
  }
  return planeData
}

function lookupPlaneRecord(
  globalRepo: Repository,
  query: string,
  bodyStore: Record<string, Body> | null,
): PlaneRecord | null {
  // A bare builtin name is a UI spelling, not a repo key: the repo holds
  // `builtin_plane_top`, so translate before asking it anything.
  const bareId = resolveBarePlaneId(query) ?? resolveBarePlaneId(query.replace(/^@/, ''))
  if (bareId !== null) return globalRepo.query('@' + bareId, null, bodyStore) as PlaneRecord | null
  const direct = globalRepo.query(query, null, bodyStore) as PlaneRecord | null
  if (direct !== null) return direct
  // A bare document plane id is an element key, not a query. The sketch rows
  // read it this way (`resolveSketchPlane`), so a user plane whose id is a plain
  // word resolves here too; a builtin name was already translated above.
  if (/^[@$?]/.test(query)) return null
  const element = globalRepo.elements.get(query) as PlaneRecord | undefined
  return element ?? null
}

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
  const planeData = resolvePlaneRecord(globalRepo, query, bodyStore, leaf)

  let origin: number[]
  let normal: number[]
  if (isFrameRecord(planeData)) {
    origin = planeData.origin as number[]
    normal = planeData.normal as number[]
  } else {
    origin = (planeData.origin as number[] | undefined) ?? [0, 0, 0]
    normal = (planeData.normal as number[] | undefined) ?? [0, 0, 1]
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

/** The inverse of [[sketchToWorld2d]]: project a 3D world point onto the plane
 *  frame as [u, v] sketch coords. Only the in-plane basis is needed, so a frame
 *  without a normal is accepted too. */
export function worldToSketch2d(xyz: number[], plane: Pick<PlaneLike, 'origin' | 'x_axis' | 'y_axis'>): number[] {
  const rel = sub(xyz, plane.origin)
  return [dot(rel, plane.x_axis), dot(rel, plane.y_axis)]
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
