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
import type { Vec3 } from '../occ/primitives'
import { makePrism } from '../occ/primitives'
import { booleanWithHistory } from '../occ/booleans'
import { extractOccFace, computeFacePlane } from '../occ/faceLoops'

type Dict = Record<string, unknown>

export interface CutPlane {
  origin: Vec3
  normal: Vec3
}

/** Reach used for the over-length prism and the trimming half-space (model units). */
export const UP_TO_REACH = 1e4

function dot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a: number[], b: number[]): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function normalize(v: number[]): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2])
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 1]
}

/** Two orthonormal in-plane axes for a plane with the given normal. */
function inPlaneAxes(normal: Vec3): [Vec3, Vec3] {
  const seed: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u = normalize(cross(seed, normal))
  const v = normalize(cross(normal, u))
  return [u, v]
}

/**
 * Resolve an `up_to` ref to a cutting plane. Handles registered planes/flatfaces
 * (origin + normal), planar body faces (body_id + face_index), and points
 * (point/position coordinate, plane normal = the extrude direction). Returns null
 * when the ref does not resolve (caller falls back to the blind distance).
 * Throws when a face target is non-planar, so a bad pick surfaces as an error.
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
  } catch {
    entry = null
  }
  if (entry === null) return null

  // Registered plane / flatface (datum plane, an extrude top_face, ...).
  const planeOrigin = (entry.origin ?? entry.centroid) as number[] | undefined
  if (Array.isArray(entry.normal) && Array.isArray(planeOrigin)) {
    return { origin: [...(planeOrigin as number[])] as Vec3, normal: normalize(entry.normal as number[]) }
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
    return { origin: [...plane.origin] as Vec3, normal: normalize(plane.normal) }
  }

  // Point / vertex: the plane through the point, perpendicular to the extrude.
  const pt = (entry.point ?? entry.position) as number[] | undefined
  if (Array.isArray(pt) && pt.length === 3) {
    return { origin: [...pt] as Vec3, normal: normalize(directionVec) }
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
  const faceBuilder = scope.track(new oc.BRepBuilderAPI_MakeFace_15(scope.track(poly.Wire()), true))
  const capFace = faceBuilder.Face()
  // Sweep the cap back toward the profile (opposite the extrude direction) so the
  // box covers the keep side; depth exceeds the over-length prism.
  const keepDir: Vec3 = [-directionVec[0], -directionVec[1], -directionVec[2]]
  const halfSpace = makePrism(oc, scope, capFace, keepDir, big + UP_TO_REACH)
  return booleanWithHistory(oc, scope, solid, halfSpace, 'common').shape
}
