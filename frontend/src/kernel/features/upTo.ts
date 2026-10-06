// Extrude "up to" termination (feature: extrude-up-to).
//
// The end of the extrude is defined by a picked element instead of a numeric
// distance: a plane, a point, or a planar B-rep face. v1 reduces every terminator
// to a cutting plane (origin + normal) and trims an over-length prism with a
// boolean Common against a half-space on the keep side of that plane. OCC's
// native BRepFeat_MakePrism (true "until face") is not bound; curved terminators
// and "up to next body" are deferred to v2.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { HandleTable, OccHandle } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { AmbiguousQueryError } from '../query'
import type { Vec3 } from '../occ/primitives'
import { makePrism } from '../occ/primitives'
import { dot, cross } from '@/utils/vec3'
import { booleanWithHistory, countSolids } from '../occ/booleans'
import { extractOccFace, computeFacePlane } from '../occ/faceLoops'

type Dict = Record<string, unknown>

export interface CutPlane {
  origin: Vec3
  normal: Vec3
}

/** Reach used for the over-length prism and the trimming half-space (model units). */
export const UP_TO_REACH = 1e4

function normalize(v: number[]): Vec3 | null {
  const l = Math.hypot(v[0], v[1], v[2])
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : null
}

/** Two orthonormal in-plane axes for a plane with the given normal. */
function inPlaneAxes(normal: Vec3): [Vec3, Vec3] {
  const seed: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u = normalize(cross(seed, normal))
  if (u === null) throw new Error('extrude up_to: degenerate in-plane axis')
  const v = normalize(cross(normal, u))
  if (v === null) throw new Error('extrude up_to: degenerate in-plane axis')
  return [u, v]
}

/**
 * Resolve an `up_to` ref to a cutting plane. Handles registered planes/flatfaces
 * (origin + normal), planar body faces (body_id + face_index), and points
 * (point/position coordinate, plane normal = the extrude direction). Returns null
 * when the ref does not resolve (caller falls back to the blind distance).
 * Rethrows AmbiguousQueryError so the caller can report ambiguity distinctly
 * from a dangling pick. Throws when a face target is non-planar, so a bad pick
 * surfaces as an error.
 */
export function resolveUpToPlane(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  upToRef: string,
  directionVec: Vec3,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): CutPlane | null {
  if (!upToRef) return null
  let entry: Dict | null
  try {
    entry = globalRepo.query(upToRef, null, bodyStore) as Dict | null
  } catch (e) {
    if (e instanceof AmbiguousQueryError) throw e
    // A dangling pick falls back to the blind distance, but ambiguity must not
    // pose as "did not resolve": the resolver DID match elements, several of
    // them. Rethrow so the caller can name the ambiguity in its warning.
    entry = null
  }
  if (entry === null) return null

  // Registered plane / flatface (datum plane, an extrude top_face, ...).
  // Both tags are accepted because a datum plane registers as `plane`
  // (plane.ts) while an extrude top_face and a planar body face register as
  // `flatface`; admitting only `flatface` made a datum-plane pick fall through
  // every branch and silently become the blind distance. Curved body faces are
  // neither tag, so they still reach the planarity check below.
  const planeOrigin = (entry.origin ?? entry.centroid) as number[] | undefined
  if ((entry.type === 'flatface' || entry.type === 'plane') && Array.isArray(entry.normal) && Array.isArray(planeOrigin)) {
    const n = normalize(entry.normal as number[])
    if (n === null) throw new Error('extrude up_to: degenerate normal on registered plane')
    return { origin: [...(planeOrigin as number[])] as Vec3, normal: n }
  }

  // Planar body face.
  const bodyId = entry.body_id as string | undefined
  const faceIndex = entry.face_index as number | undefined
  if (bodyId !== undefined && faceIndex !== undefined) {
    const body = bodyStore[bodyId]
    if (body === undefined || body.shape === null) return null
    const face = extractOccFace(oc, scope, table.get<OccShape>(body.shape as OccHandle), faceIndex)
    let plane
    try {
      plane = computeFacePlane(oc, scope, face)
    } catch {
      throw new Error('extrude up_to: target face is not planar (v1 supports planar targets only)')
    }
    const n = normalize(plane.normal)
    if (n === null) throw new Error('extrude up_to: degenerate face normal')
    return { origin: [...plane.origin] as Vec3, normal: n }
  }

  // Point / vertex: the plane through the point, perpendicular to the extrude.
  const pt = (entry.point ?? entry.position) as number[] | undefined
  if (Array.isArray(pt) && pt.length === 3) {
    const n = normalize(directionVec)
    if (n === null) throw new Error('extrude up_to: degenerate direction vector')
    return { origin: [...pt] as Vec3, normal: n }
  }

  return null
}

/** Signed distance from `profileOrigin` to the cut plane along `directionVec`. */
export function upToDistance(cut: CutPlane, profileOrigin: number[], directionVec: Vec3): number {
  const delta = [
    cut.origin[0] - profileOrigin[0],
    cut.origin[1] - profileOrigin[1],
    cut.origin[2] - profileOrigin[2],
  ]
  return dot(delta, directionVec)
}

/**
 * Point the sweep at its terminator. A target sitting behind the profile flips
 * the extrude rather than failing: with `up_to` the picked element, not the
 * direction toggle, decides which way the material grows, so either side of the
 * profile is a valid pick. Throws when the terminator passes through the profile
 * origin, where neither direction has any reach.
 */
export function orientToTarget(cut: CutPlane, profileOrigin: number[], directionVec: Vec3): Vec3 {
  const signed = upToDistance(cut, profileOrigin, directionVec)
  if (Math.abs(signed) <= 1e-9) {
    throw new Error('extrude up_to: target passes through the profile; no distance to extrude')
  }
  if (Math.abs(signed) > UP_TO_REACH) {
    throw new Error(`extrude up_to: target is beyond reach (${Math.abs(signed).toFixed(1)} > ${UP_TO_REACH})`)
  }
  return signed > 0 ? directionVec : (directionVec.map((c) => -c) as Vec3)
}

/**
 * Trim an over-length extrude solid at the cut plane, keeping the side the
 * profile sits on. Built as a boolean Common with a half-space box whose cap
 * lies in the cut plane, so the result terminates exactly on the plane for any
 * plane orientation.
 */
export function trimAtPlane(
  oc: OccModule,
  scope: DisposeScope,
  solid: OccShape,
  cut: CutPlane,
  directionVec: Vec3,
): OccShape {
  const [u, v] = inPlaneAxes(cut.normal)
  const big = UP_TO_REACH
  const corners: Vec3[] = [
    [cut.origin[0] - big * u[0] - big * v[0], cut.origin[1] - big * u[1] - big * v[1], cut.origin[2] - big * u[2] - big * v[2]],
    [cut.origin[0] + big * u[0] - big * v[0], cut.origin[1] + big * u[1] - big * v[1], cut.origin[2] + big * u[2] - big * v[2]],
    [cut.origin[0] + big * u[0] + big * v[0], cut.origin[1] + big * u[1] + big * v[1], cut.origin[2] + big * u[2] + big * v[2]],
    [cut.origin[0] - big * u[0] + big * v[0], cut.origin[1] - big * u[1] + big * v[1], cut.origin[2] - big * u[2] + big * v[2]],
  ]
  const poly = scope.track(new oc.BRepBuilderAPI_MakePolygon_1())
  for (const c of corners) poly.Add_1(scope.track(new oc.gp_Pnt_3(c[0], c[1], c[2])))
  poly.Close()
  const wire = scope.track(poly.Wire())
  const faceBuilder = scope.track(new oc.BRepBuilderAPI_MakeFace_15(wire, true))
  // Face() on a not-done builder does not throw in this build, it returns a NULL
  // shape -- which would sweep into an empty half-space and make the Common
  // below silently delete the whole body.
  if (!faceBuilder.IsDone()) {
    throw new Error('up_to: could not build a planar cap face for the cut plane')
  }
  const capFace = scope.track(faceBuilder.Face())
  // Sweep the cap back toward the profile (opposite the extrude direction) so the
  // box covers the keep side; depth exceeds the over-length prism.
  const keepDir: Vec3 = [-directionVec[0], -directionVec[1], -directionVec[2]]
  // Cap and half-space are consumed by the Common below; release them so a
  // re-solved up_to feature does not leave one of each behind per edit.
  const halfSpace = scope.track(makePrism(oc, scope, capFace, keepDir, big + UP_TO_REACH))
  try {
    const result = booleanWithHistory(oc, scope, solid, halfSpace, 'common').shape
    if (countSolids(oc, scope, result) === 0) {
      throw new Error('extrude up_to: boolean Common produced no solid')
    }
    return result
  } finally {
    scope.release(capFace)
    scope.release(halfSpace)
  }
}
