// The free-end rule for an axis carrier: a cylindrical or conical face, or a
// circular body edge. An axis has two senses and a pick carries no position, so
// the sense must come from the geometry alone and must be stable across
// rebuilds.
//
// At each axial end of a cylindrical or conical face, look across its boundary
// circle at the neighbouring face. The end is FREE when that neighbour's
// outward normal has a positive component along the direction leaving the face
// at that end. A blind hole's mouth is free and its floor is not; a boss's top
// is free and its base is not; a countersink's wide end is free and the narrow
// end where it meets the bore is not. Exactly one free end: the axis points out
// of it. Two free ends (a through hole) or none: the surface's own OCC axis
// sense, which is stable, and `reverse_normal`/`invert` is the user's fix.
//
// A circular body edge takes its normal from its planar neighbour when it has
// one (the mouth circle borders the plate top), else from the free-end rule of
// its cylindrical or conical neighbour.

import type { DisposeScope } from '../../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape } from '../../occ/occTypes'
import type { HandleTable } from '../../occ/handleTable'
import type { Body } from '../../types3d'
import { edgeToGeom, faceNormal, faceSurfaceFrame, faceSurfaceType, type Vec3 } from '../../occ/primitives'

export interface AxisSense {
  // A point on the axis at the chosen end.
  point: Vec3
  // The unit direction the axis points out of the material.
  normal: Vec3
}

export interface AxisSenseContext {
  oc: OccModule
  scope: DisposeScope
  table: HandleTable
  // The body's faces in canonical order, cached by the caller: every target a
  // pattern resolves walks the same body again.
  facesOf: (body: Body) => OccShape[]
  // The faces sharing one edge, built once per body. A pattern of many face
  // targets would otherwise re-walk every face's edges per boundary edge.
  neighboursOf?: (body: Body, edge: OccShape) => OccShape[]
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function unit(v: readonly number[]): Vec3 | null {
  const len = Math.hypot(v[0], v[1], v[2])
  return len < 1e-12 ? null : [v[0] / len, v[1] / len, v[2] / len]
}

function along(origin: Vec3, axis: Vec3, t: number): Vec3 {
  return [origin[0] + axis[0] * t, origin[1] + axis[1] * t, origin[2] + axis[2] * t]
}

function same(a: OccShape, b: OccShape): boolean {
  return (a as OccSubShape).IsSame(b as OccSubShape)
}

export function exploreEdges(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  const E = oc.TopAbs_ShapeEnum
  const out: OccShape[] = []
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) out.push(scope.track(oc.TopoDS.Edge_1(exp.Current())))
  return out
}

/** Every face of the body that shares `edge`, apart from `exclude`. */
function neighbourFaces(
  ctx: AxisSenseContext,
  body: Body,
  edge: OccShape,
  exclude: OccShape | null,
): OccShape[] {
  const cached = ctx.neighboursOf?.(body, edge) ?? null
  if (cached !== null) {
    return exclude === null ? cached : cached.filter((face) => !same(face, exclude))
  }
  const out: OccShape[] = []
  for (const face of ctx.facesOf(body)) {
    if (exclude !== null && same(face, exclude)) continue
    if (exploreEdges(ctx.oc, ctx.scope, face).some((candidate) => same(candidate, edge))) out.push(face)
  }
  return out
}

/** Where one boundary edge sits along the axis, or null when its geometry
 *  cannot be read (a degenerate seam, which is not an end). */
function axialPosition(oc: OccModule, scope: DisposeScope, edge: OccShape, origin: Vec3, axis: Vec3): number | null {
  let geom: ReturnType<typeof edgeToGeom>['ed']
  try {
    geom = edgeToGeom(oc, scope, edge).ed
  } catch {
    return null
  }
  if (geom.kind === 'circle' || geom.kind === 'arc') {
    return dot([geom.center[0] - origin[0], geom.center[1] - origin[1], geom.center[2] - origin[2]], axis)
  }
  if (geom.kind === 'line') {
    const midpoint: Vec3 = [
      (geom.start[0] + geom.end[0]) / 2,
      (geom.start[1] + geom.end[1]) / 2,
      (geom.start[2] + geom.end[2]) / 2,
    ]
    return dot([midpoint[0] - origin[0], midpoint[1] - origin[1], midpoint[2] - origin[2]], axis)
  }
  if (geom.kind === 'ellipse') {
    return dot([geom.center[0] - origin[0], geom.center[1] - origin[1], geom.center[2] - origin[2]], axis)
  }
  return null
}

/**
 * The free end of a cylindrical or conical face, or null for any other surface
 * (a plane's normal is already the answer, and a sphere or torus has no axial
 * end). Every end with a neighbouring face whose outward normal leaves the face
 * is free; one free end decides, two or none fall back to the surface's own OCC
 * axis sense.
 */
export function faceFreeEnd(ctx: AxisSenseContext, body: Body, face: OccShape): AxisSense | null {
  const kind = faceSurfaceType(ctx.oc, ctx.scope, face)
  if (kind !== 'cylinderface' && kind !== 'coneface') return null
  const frame = faceSurfaceFrame(ctx.oc, ctx.scope, face)
  if (frame === null) return null
  const axis = unit(frame.axis)
  if (axis === null) return null
  const origin: Vec3 = [frame.origin[0], frame.origin[1], frame.origin[2]]

  // Each boundary edge belongs to one axial end. A seam edge's geometry does not
  // read, and it is not an end, so it drops out here.
  const ends: { axial: number; edges: OccShape[] }[] = []
  for (const edge of exploreEdges(ctx.oc, ctx.scope, face)) {
    const axial = axialPosition(ctx.oc, ctx.scope, edge, origin, axis)
    if (axial === null) continue
    const existing = ends.find((end) => Math.abs(end.axial - axial) < 1e-6)
    if (existing === undefined) ends.push({ axial, edges: [edge] })
    else existing.edges.push(edge)
  }
  if (ends.length === 0) return null
  // Exactly two axial ends on a full cylinder or cone; a trimmed face may have
  // several, and its outermost edges still name which way the axis points.
  ends.sort((a, b) => a.axial - b.axial)
  const low = ends[0]
  const high = ends[ends.length - 1]

  const isFree = (end: { axial: number; edges: OccShape[] }, leaving: Vec3): boolean => {
    for (const edge of end.edges) {
      for (const neighbour of neighbourFaces(ctx, body, edge, face)) {
        try {
          if (dot(faceNormal(ctx.oc, ctx.scope, neighbour), leaving) > 1e-9) return true
        } catch {
          // A neighbour whose normal is not defined gives no evidence; the other
          // boundary edges still decide.
        }
      }
    }
    return false
  }

  const negated: Vec3 = [-axis[0], -axis[1], -axis[2]]
  const lowFree = low !== high && isFree(low, negated)
  const highFree = isFree(high, axis)
  if (lowFree !== highFree) {
    return lowFree
      ? { point: along(origin, axis, low.axial), normal: negated }
      : { point: along(origin, axis, high.axial), normal: axis }
  }
  // Two free ends or none: the surface's own axis sense. The point is the end
  // that sense runs to, so a through hole and an internal bore stay stable.
  return { point: along(origin, axis, high.axial), normal: axis }
}

/**
 * The sense of a circular body edge. A planar neighbour decides first (the
 * mouth circle borders the plate top, whose outward normal is the answer), else
 * the edge inherits its cylindrical or conical neighbour's free-end sense. A
 * bare edge with neither keeps the axis it was resolved with.
 */
export function circularEdgeSense(
  ctx: AxisSenseContext,
  body: Body,
  edge: OccShape,
  center: Vec3,
  axis: Vec3,
): AxisSense {
  const faces = neighbourFaces(ctx, body, edge, null)
  // A rim can border two planes (a boss top cap and its side). The one whose
  // normal runs along the edge axis is the cap the circle belongs to; a side
  // face is perpendicular and is not the sense the copy wants.
  const planar: Vec3[] = []
  for (const face of faces) {
    try {
      if (faceSurfaceType(ctx.oc, ctx.scope, face) === 'flatface') {
        planar.push(faceNormal(ctx.oc, ctx.scope, face))
      }
    } catch {
      // Not a readable face; the curved neighbour below is the next evidence.
    }
  }
  const unitAxis = unit(axis)
  const aligned = unitAxis === null
    ? undefined
    : planar.find((candidate) => Math.abs(dot(candidate, unitAxis)) > 0.99)
  const chosen = aligned ?? planar[0]
  if (chosen !== undefined) {
    return { point: [center[0], center[1], center[2]], normal: chosen }
  }
  for (const face of faces) {
    const sense = faceFreeEnd(ctx, body, face)
    if (sense !== null) return { point: [center[0], center[1], center[2]], normal: sense.normal }
  }
  const fallback = unit(axis) ?? [0, 0, 1]
  return { point: [center[0], center[1], center[2]], normal: fallback }
}
