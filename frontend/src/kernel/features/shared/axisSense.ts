// The sense of an axis carrier: which way along its own axis a cylindrical face,
// conical face or circular edge points. An axis has two senses and a pick carries
// no position, so the leaf must derive the sense from the geometry alone.
//
// The free-end rule, applied at each axial end of a cylindrical or conical face:
// look across the boundary edge at the neighbour face; the end is FREE when the
// neighbour's outward normal has a positive component along the direction that
// leaves the face at that end (along the axis at the high end, against it at the
// low end). A blind hole's mouth, a boss's top and a countersink's wide end are
// free; a hole floor, a boss base and a countersink's narrow end are not. One
// free end orients the axis out of it. Two free ends (a through hole) or none is
// the surface's own OCC `gp_Ax1` sense, which is stable over rebuilds; `invert`
// is the user's fix there.
//
// A circular body edge takes its planar neighbour's outward normal, else its
// cylindrical/conical neighbour's rule. A sketch circle or arc has no body
// geometry to read and takes the sketch plane normal, which the direction
// resolver already hands over.
//
// The face's axial extent is read here too: directive-length spacing is the
// pick's own length, which for a face is how far it runs along its axis.

import type { DisposeScope } from '../../occ/disposeScope'
import type { HandleTable } from '../../occ/handleTable'
import type { OccModule, OccShape, OccSubShape } from '../../occ/occTypes'
import type { PartSolid } from '../../types3d'
import type { Repository } from '../../query'
import { extractOccFace } from '../../occ/faceLoops'
import { canonicalEdges } from '../../occ/partNames'
import { exploreEdges, exploreFaces } from '../../occ/edgeModifier'
import { SubShapeMultiIndex } from '../../occ/subshapeIdentity'
import { faceNormal, faceSurfaceFrame, type Vec3 } from '../../occ/primitives'

type Dict = Record<string, unknown>

/** What resolving an axis carrier's sense needs from the OCC side. */
export interface AxisSenseContext {
  oc: OccModule
  scope: DisposeScope
  table: HandleTable
}

/** The axis carriers a direction pick accepts. A sketch circle has no body
 *  geometry; the resolver hands its sketch normal in as the raw axis. */
export type AxisCarrierKind = 'cylinderface' | 'coneface' | 'circular_edge' | 'sketch_circle'

export interface AxisCarrierResult {
  // Unit direction along the carrier's axis, the free-end rule applied.
  direction: Vec3
  // How far the carrier runs along that axis, or null when it has no length
  // (a circular edge, a sketch circle).
  extent: number | null
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

const unit = (v: Vec3): Vec3 | null => {
  const len = Math.hypot(v[0], v[1], v[2])
  return len > 1e-12 ? [v[0] / len, v[1] / len, v[2] / len] : null
}

/** The payload a query resolved into, or null. */
function payloadOf(query: string, globalRepo: Repository, partStore: Dict): Dict | null {
  return globalRepo.query(query, null, partStore) as Dict | null
}

/** The OCC shape of the body a payload names, or null when the store no longer
 *  holds it. */
function partShapeOf(data: Dict, partStore: Dict, ctx: AxisSenseContext): OccShape | null {
  const partId = data.body_id as string | undefined
  if (partId === undefined) return null
  const part = partStore[partId] as PartSolid | undefined
  if (part === undefined || part.shape === null) return null
  return ctx.table.get<OccShape>(part.shape)
}

function faceOfQuery(
  query: string,
  globalRepo: Repository,
  partStore: Dict,
  ctx: AxisSenseContext,
): OccShape | null {
  const data = payloadOf(query, globalRepo, partStore)
  if (data === null) return null
  const index = data.face_index as number | undefined
  const shape = partShapeOf(data, partStore, ctx)
  if (shape === null || index === undefined) return null
  try {
    return extractOccFace(ctx.oc, ctx.scope, shape, index)
  } catch {
    return null
  }
}

function edgeOfQuery(
  query: string,
  globalRepo: Repository,
  partStore: Dict,
  ctx: AxisSenseContext,
): OccShape | null {
  const data = payloadOf(query, globalRepo, partStore)
  if (data === null) return null
  const index = data.edge_index as number | undefined
  const shape = partShapeOf(data, partStore, ctx)
  if (shape === null || index === undefined) return null
  return canonicalEdges(ctx.oc, ctx.scope, shape)[index] ?? null
}

/** A point partway along an edge, used only to place the edge along the axis. */
function edgeMidpoint(ctx: AxisSenseContext, edge: OccShape): Vec3 {
  const adaptor = ctx.scope.track(new ctx.oc.BRepAdaptor_Curve_2(edge))
  const mid = adaptor.Value((adaptor.FirstParameter() + adaptor.LastParameter()) / 2)
  const point: Vec3 = [mid.X(), mid.Y(), mid.Z()]
  mid.delete()
  return point
}

interface AxialEnd {
  edge: OccShape
  t: number
}

/** The boundary edge at each axial end of a face. A full cylinder or cone also
 *  meets its own seam edge, whose midpoint sits between the ends, so the
 *  extremes of the projected boundary are the two ends. */
function axialEnds(ctx: AxisSenseContext, face: OccShape, axis: Vec3, origin: Vec3): AxialEnd[] {
  const ends: AxialEnd[] = []
  for (const edge of exploreEdges(ctx.oc, ctx.scope, face)) {
    const mid = edgeMidpoint(ctx, edge)
    const t = (mid[0] - origin[0]) * axis[0] + (mid[1] - origin[1]) * axis[1] + (mid[2] - origin[2]) * axis[2]
    ends.push({ edge, t })
  }
  if (ends.length === 0) return []
  const low = ends.reduce((a, b) => (b.t < a.t ? b : a))
  const high = ends.reduce((a, b) => (b.t > a.t ? b : a))
  return low === high ? [low] : [low, high]
}

/** The faces a body meets an edge with, this face excluded. The kernel build
 *  has no bound TopTools adjacency map, so the index is a face walk; one walk
 *  serves both ends of one pick. */
function neighbourIndex(ctx: AxisSenseContext, shape: OccShape): SubShapeMultiIndex<OccSubShape> {
  const byEdge = new SubShapeMultiIndex<OccSubShape>()
  for (const candidate of exploreFaces(ctx.oc, ctx.scope, shape)) {
    for (const edge of exploreEdges(ctx.oc, ctx.scope, candidate)) byEdge.add(edge as OccSubShape, candidate as OccSubShape)
  }
  return byEdge
}

/** True when a neighbour's outward normal points away from the face at that
 *  end, which is what makes the end free (a mouth, a boss top, a wide cone
 *  end). The neighbour's normal is read at its own domain midpoint: a planar
 *  neighbour's is constant, and a coaxial cone's axial component is too. */
function endIsFree(ctx: AxisSenseContext, neighbours: readonly OccSubShape[], leaving: Vec3): boolean {
  return neighbours.some((neighbour) => dot(faceNormal(ctx.oc, ctx.scope, neighbour), leaving) > 1e-6)
}

interface FaceAxis {
  axis: Vec3
  origin: Vec3
}

function faceAxis(ctx: AxisSenseContext, face: OccShape): FaceAxis | null {
  const frame = faceSurfaceFrame(ctx.oc, ctx.scope, face)
  if (frame === null) return null
  const axis = unit(frame.axis)
  return axis === null ? null : { axis, origin: frame.origin }
}

/** The face's span along its own axis: the V parameter for a cylinder, and the
 *  same parameter times cos(semi-angle) for a cone (its V runs along the
 *  generatrix, so the axial height is that projection). */
function faceAxialExtent(ctx: AxisSenseContext, face: OccShape): number | null {
  const { oc, scope } = ctx
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const span = Math.abs(adaptor.LastVParameter() - adaptor.FirstVParameter())
  const type = adaptor.GetType().value
  if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder.value) return span
  if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cone.value) {
    const cone = scope.track(adaptor.Cone())
    return span * Math.abs(Math.cos(cone.SemiAngle()))
  }
  return null
}

/** Apply the free-end rule to one cylindrical or conical face. */
function faceDirection(ctx: AxisSenseContext, face: OccShape, shape: OccShape): FaceAxis | null {
  const frame = faceAxis(ctx, face)
  if (frame === null) return null
  const ends = axialEnds(ctx, face, frame.axis, frame.origin)
  if (ends.length < 2) return frame
  const byEdge = neighbourIndex(ctx, shape)
  const free = ends.map((end) => {
    const neighbours = byEdge.get(end.edge as OccSubShape).filter((n) => !n.IsSame(face))
    // The direction that leaves the face at this end: away from the face's own
    // interior, so against the axis at the low end.
    const sign = end === ends[0] ? -1 : 1
    const leaving: Vec3 = [frame.axis[0] * sign, frame.axis[1] * sign, frame.axis[2] * sign]
    return endIsFree(ctx, neighbours, leaving)
  })
  if (free[0] === free[1]) return frame
  const sign = free[1] ? 1 : -1
  return { axis: [frame.axis[0] * sign, frame.axis[1] * sign, frame.axis[2] * sign], origin: frame.origin }
}

/** A circular body edge: its planar neighbour's outward normal when it has one,
 *  else the cylindrical/conical neighbour's own rule. */
function circularEdgeDirection(
  ctx: AxisSenseContext,
  edge: OccShape,
  shape: OccShape,
  rawAxis: Vec3,
): Vec3 | null {
  const neighbours = neighbourIndex(ctx, shape).get(edge as OccSubShape)
  // A rim's planar neighbour is the end face the edge bounds, so its outward
  // normal lies on the circle's axis. One that does not (a tangent face) says
  // nothing about the sense and is skipped.
  for (const neighbour of neighbours) {
    if (faceSurfaceFrame(ctx.oc, ctx.scope, neighbour) !== null) continue
    const normal = faceNormal(ctx.oc, ctx.scope, neighbour)
    if (Math.abs(dot(normal, rawAxis)) < 1 - 1e-6) continue
    return dot(normal, rawAxis) >= 0 ? rawAxis : [-rawAxis[0], -rawAxis[1], -rawAxis[2]]
  }
  for (const neighbour of neighbours) {
    if (faceSurfaceFrame(ctx.oc, ctx.scope, neighbour) === null) continue
    const direction = faceDirection(ctx, neighbour, shape)
    if (direction !== null) return direction.axis
  }
  return null
}

/**
 * Resolve an axis carrier's direction and, for a face, its axial extent. Null
 * when the carrier's geometry cannot be reached; the direction resolver then
 * keeps the payload's raw axis, and a directive-length pick refuses by name
 * because it has no extent to give.
 */
export function resolveAxisCarrier(
  kind: AxisCarrierKind,
  query: string,
  rawAxis: Vec3 | null,
  ctx: AxisSenseContext,
  globalRepo: Repository,
  partStore: Dict,
): AxisCarrierResult | null {
  if (kind === 'sketch_circle') {
    const axis = rawAxis === null ? null : unit(rawAxis)
    return axis === null ? null : { direction: axis, extent: null }
  }
  const data = payloadOf(query, globalRepo, partStore)
  if (data === null) return null
  const shape = partShapeOf(data, partStore, ctx)
  if (shape === null) return null

  if (kind === 'circular_edge') {
    const axis = rawAxis === null ? null : unit(rawAxis)
    const edge = edgeOfQuery(query, globalRepo, partStore, ctx)
    if (axis === null || edge === null) return null
    const direction = circularEdgeDirection(ctx, edge, shape, axis)
    return direction === null ? null : { direction, extent: null }
  }

  // A cylinder or cone: the face itself carries the axis (the payload's `axis`
  // is cylinder-only), and the free-end rule reads the neighbour faces.
  const face = faceOfQuery(query, globalRepo, partStore, ctx)
  if (face === null) return null
  const direction = faceDirection(ctx, face, shape)
  if (direction === null) return null
  return { direction: direction.axis, extent: faceAxialExtent(ctx, face) }
}
