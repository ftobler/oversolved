// A blend on a straight edge between two planes, measured and built as a prism.
//
// OCC's rolling-ball builder cannot consume a face it was not asked to blend:
// ChFi3d has no switch for it in this pinned 7.4 build, so a fillet whose
// setback runs past a small end face refuses with a bare build_failed. Where
// the picked edge is a straight line and both adjacent faces are planes, the
// blend cross-section is constant along the edge, so it can be cut instead: the
// corner region between the two face planes and the blend arc (fillet) or chord
// (chamfer), extruded over exactly the edge's length.
//
// This module only measures and builds. Whether the prism is the rolling-ball
// result -- perpendicular planar caps, no tangent chain, a consumed end face --
// is the leaf's decision (features/endFaceBlend.ts), and it is made on the
// pre-modifier shape.

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccSubShape } from './occTypes'
import { canonicalEdges, canonicalFaces, canonicalVertices } from './bodyNames'
import {
  faceNormal,
  makeArcEdge,
  makeFaceFromWire,
  makeLineEdge,
  makeWire,
  type Vec3,
} from './primitives'
import { countSolids } from './booleans'

type ShapePair = [OccShape, OccShape]
type VecPair = [Vec3, Vec3]
type NumberPair = [number, number]

/** What to build at the corner: a fillet arc or a chamfer chord. */
export type CornerBlendSpec =
  | { kind: 'fillet'; radius: number }
  | { kind: 'chamfer'; distance: number; angleRad?: number }

/** The corner a blend sits in, read off the pre-modifier shape. */
export interface CornerFit {
  // Start vertex and the edge direction leaving it (unit); `from`/`to` are the
  // edge's end vertices.
  from: Vec3
  to: Vec3
  direction: Vec3
  length: number
  // The two planes that contain the edge, in canonical face order (the order
  // BRepFilletAPI's chamfer reference face is found in).
  faces: ShapePair
  // Their outward normals.
  normals: VecPair
  // The in-plane direction into each face, perpendicular to the edge.
  inward: VecPair
  // The interior dihedral angle between the faces, from their outward normals.
  angle: number
  // How far the blend runs along each face from the edge: equal for a fillet
  // and a distance chamfer, asymmetric for an angle-distance chamfer.
  setbacks: NumberPair
}

/** How an end face reaches from the edge's end vertex along the two faces. */
export interface EndFaceReach {
  at: Vec3
  // Along `inward[0]` and `inward[1]`, the distance to the end face's edge.
  extents: NumberPair
  // False when the end face is not square to the edge, where an extent has no
  // single value: the blend does not end flat on it.
  square: boolean
  tiltDeg: number
}

/** A blend tool: the solid to cut and the face it leaves on the body. */
export interface CornerTool {
  shape: OccShape
  // The arc (fillet) or chord (chamfer) face, IsSame one of `shape`'s faces.
  blendFace: OccShape
}

/** How far a face may lean off square to the edge and still count as square. */
export const SQUARE_ANGULAR_TOL = 1e-3

/** How far a face may lean off square and still be a CAP the blend ends on. A
 *  side wall at the vertex stands at 90 degrees to the edge and is not one; the
 *  fit refuses to call those consumed. */
const CAP_TILT_LIMIT = Math.cos(Math.PI / 4)

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

const unit = (v: Vec3): Vec3 | null => {
  const len = Math.hypot(v[0], v[1], v[2])
  return len > 1e-12 ? [v[0] / len, v[1] / len, v[2] / len] : null
}

/**
 * The outward normal of a face that LIES on a plane, analytic or not, or null
 * for a curved one. A draft prism's lateral faces are B-spline surfaces on an
 * exact plane, so the analytic surface type alone would call a tapered lip's
 * side faces curved and refuse to measure a corner that is genuinely flat.
 * Planarity is sampled, not assumed: a cylinder or cone fails the parallel
 * normals immediately, and a saddle would fail the on-plane test.
 */
export function planarFaceNormal(oc: OccModule, scope: DisposeScope, face: OccShape): Vec3 | null {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const type = adaptor.GetType().value
  if (type === oc.GeomAbs_SurfaceType.GeomAbs_Plane.value) return faceNormal(oc, scope, face)
  const u0 = adaptor.FirstUParameter()
  const u1 = adaptor.LastUParameter()
  const v0 = adaptor.FirstVParameter()
  const v1 = adaptor.LastVParameter()
  const p = scope.track(new oc.gp_Pnt_1())
  const du = scope.track(new oc.gp_Vec_1())
  const dv = scope.track(new oc.gp_Vec_1())
  const points: Vec3[] = []
  const normals: Vec3[] = []
  for (const fu of [0.15, 0.5, 0.85]) {
    for (const fv of [0.15, 0.5, 0.85]) {
      adaptor.D1(u0 + (u1 - u0) * fu, v0 + (v1 - v0) * fv, p, du, dv)
      const n = normalOf(du, dv)
      if (n === null) return null
      normals.push(n)
      points.push([p.X(), p.Y(), p.Z()])
    }
  }
  const first = normals[0]
  const parallel = Math.cos(SQUARE_ANGULAR_TOL)
  if (!normals.every((n) => Math.abs(dot3(n, first)) >= parallel)) return null
  const span = Math.max(1, ...points.map((q) => Math.hypot(q[0], q[1], q[2])))
  if (!points.every((q) => Math.abs(dot3(sub3(q, points[0]), first)) <= 1e-6 * span)) return null
  return faceNormal(oc, scope, face)
}

function normalOf(du: { X(): number; Y(): number; Z(): number }, dv: { X(): number; Y(): number; Z(): number }): Vec3 | null {
  const n: Vec3 = [
    du.Y() * dv.Z() - du.Z() * dv.Y(),
    du.Z() * dv.X() - du.X() * dv.Z(),
    du.X() * dv.Y() - du.Y() * dv.X(),
  ]
  return unit(n)
}

function addScaled(p: Vec3, axis: Vec3, s: number): Vec3 {
  return [p[0] + axis[0] * s, p[1] + axis[1] * s, p[2] + axis[2] * s]
}

function vertexPoint(oc: OccModule, scope: DisposeScope, vertex: OccShape): Vec3 {
  const p = scope.track(oc.BRep_Tool.Pnt(vertex))
  return [p.X(), p.Y(), p.Z()]
}

function facesOf(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  return canonicalFaces(oc, scope, shape) as OccShape[]
}

function edgesOf(oc: OccModule, scope: DisposeScope, face: OccShape): OccShape[] {
  return canonicalEdges(oc, scope, face) as OccShape[]
}

function hasEdge(oc: OccModule, scope: DisposeScope, face: OccShape, edge: OccShape): boolean {
  return edgesOf(oc, scope, face).some((e) => (e as OccSubShape).IsSame(edge as OccSubShape))
}

/** The faces that meet a vertex, in canonical face order. */
export function facesAtVertex(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  vertex: OccShape,
): OccShape[] {
  const out: OccShape[] = []
  for (const face of facesOf(oc, scope, shape)) {
    const meets = edgesOf(oc, scope, face).some((edge) =>
      canonicalVertices(oc, scope, edge).some((v) => (v as OccSubShape).IsSame(vertex as OccSubShape)),
    )
    if (meets) out.push(face)
  }
  return out
}

/** A straight edge's two end vertices and its unit direction, or null for a
 *  curved edge or one whose ends cannot be read. A draft prism's lateral edges
 *  are B-spline curves that lie on a line, so straightness is sampled as well
 *  as read from the analytic type. */
function straightEdge(oc: OccModule, scope: DisposeScope, edge: OccShape): {
  from: Vec3
  to: Vec3
  direction: Vec3
  length: number
} | null {
  const curve = scope.track(new oc.BRepAdaptor_Curve_2(edge))
  const vertices = canonicalVertices(oc, scope, edge)
  if (vertices.length < 2) return null
  const from = vertexPoint(oc, scope, vertices[0])
  const to = vertexPoint(oc, scope, vertices[vertices.length - 1])
  const delta = sub3(to, from)
  const length = Math.hypot(delta[0], delta[1], delta[2])
  const direction = unit(delta)
  if (direction === null || !(length > 1e-9)) return null
  const analytic = curve.GetType().value === oc.GeomAbs_CurveType.GeomAbs_Line.value
  if (!analytic) {
    const first = curve.FirstParameter()
    const last = curve.LastParameter()
    for (const f of [0.25, 0.5, 0.75]) {
      const p = curve.Value(first + (last - first) * f)
      const at: Vec3 = [p.X(), p.Y(), p.Z()]
      p.delete()
      const off = sub3(at, from)
      const along = dot3(off, direction)
      const distance = Math.hypot(
        off[0] - direction[0] * along,
        off[1] - direction[1] * along,
        off[2] - direction[2] * along,
      )
      if (distance > 1e-6 * Math.max(1, length)) return null
    }
  }
  return { from, to, direction, length }
}

/**
 * The corner at `edge`, or null when the prism is not the rolling-ball result:
 * a curved edge, a curved adjacent face, a concave edge, or a spec whose
 * setbacks cannot be placed. `spec.kind` decides the setback: a fillet sets
 * back `r / tan(theta/2)` along both faces, a chamfer its distance (and, for an
 * angle-distance chamfer, the matching leg on the other face).
 *
 * Nothing here checks the END faces: a blend that ends on a perpendicular
 * planar cap is exactly this prism, but whether it does is measured against the
 * body, not the corner (see `endFaceReach`).
 */
export function cornerFit(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  edge: OccShape,
  spec: CornerBlendSpec,
): CornerFit | null {
  const line = straightEdge(oc, scope, edge)
  if (line === null) return null
  const adjacent = facesOf(oc, scope, shape).filter((f) => hasEdge(oc, scope, f, edge))
  if (adjacent.length !== 2) return null
  const [fa, fb] = adjacent
  if ((fa as OccSubShape).IsSame(fb as OccSubShape)) return null
  const na = planarFaceNormal(oc, scope, fa)
  const nb = planarFaceNormal(oc, scope, fb)
  if (na === null || nb === null) return null
  // A prism cut removes material from a convex corner. A concave one is a fill,
  // which this tool cannot produce.
  if (!isConvexEdge(oc, scope, shape, edge)) return null

  const normals: VecPair = [na, nb]
  const cos = Math.min(1, Math.max(-1, dot3(normals[0], normals[1])))
  const angle = Math.PI - Math.acos(cos)
  if (!(angle > 1e-6) || !(angle < Math.PI - 1e-6)) return null

  // The material side of the corner is the wedge's interior, opposite the two
  // outward normals; a direction perpendicular to the edge that points into a
  // face lies inside that wedge on exactly one sign.
  const bisector = unit([-(normals[0][0] + normals[1][0]), -(normals[0][1] + normals[1][1]), -(normals[0][2] + normals[1][2])])
  if (bisector === null) return null
  const inward = (normal: Vec3): Vec3 | null => {
    const perpendicular = unit([
      line.direction[1] * normal[2] - line.direction[2] * normal[1],
      line.direction[2] * normal[0] - line.direction[0] * normal[2],
      line.direction[0] * normal[1] - line.direction[1] * normal[0],
    ])
    if (perpendicular === null) return null
    return dot3(perpendicular, bisector) >= 0
      ? perpendicular
      : [-perpendicular[0], -perpendicular[1], -perpendicular[2]]
  }
  const t1 = inward(normals[0])
  const t2 = inward(normals[1])
  if (t1 === null || t2 === null) return null

  let setbacks: NumberPair
  if (spec.kind === 'fillet') {
    if (!(spec.radius > 0)) return null
    const setback = spec.radius / Math.tan(angle / 2)
    if (!(setback > 1e-9)) return null
    setbacks = [setback, setback]
  } else {
    if (!(spec.distance > 0)) return null
    if (spec.angleRad === undefined) {
      setbacks = [spec.distance, spec.distance]
    } else {
      const sinTotal = Math.sin(angle + spec.angleRad)
      if (!(Math.abs(sinTotal) > 1e-9)) return null
      setbacks = [spec.distance, (spec.distance * Math.sin(spec.angleRad)) / sinTotal]
      if (!(setbacks[1] > 1e-9)) return null
    }
  }

  return {
    from: line.from,
    to: line.to,
    direction: line.direction,
    length: line.length,
    faces: [fa, fb],
    normals,
    inward: [t1, t2],
    angle,
    setbacks,
  }
}

/** BRepOffset_Analyse's convex class, the same reader the move-face leaf uses:
 *  an inside corner's outward normals also meet at 90 degrees, so the angle
 *  alone cannot tell the two apart. */
function isConvexEdge(oc: OccModule, scope: DisposeScope, shape: OccShape, edge: OccShape): boolean {
  const analyse = scope.track(new oc.BRepOffset_Analyse_2(shape, SQUARE_ANGULAR_TOL))
  const list = scope.track(analyse.Type(edge))
  if (list.Size() === 0) return false
  const first = scope.track(list.First_1())
  return first.Type_2().value === oc.BRepOffset_Type.BRepOffset_Convex.value
}

/** How far `face` reaches from `vertex` along each adjacent face's in-plane
 *  direction. Null when the face is curved or the boundary edge is not a line:
 *  then the blend has no single setback to compare, and a wrong number is worse
 *  than none. */
export function endFaceReach(
  oc: OccModule,
  scope: DisposeScope,
  fit: CornerFit,
  face: OccShape,
  vertex: OccShape,
): EndFaceReach | null {
  if (planarFaceNormal(oc, scope, face) === null) return null
  const at = vertexPoint(oc, scope, vertex)
  const normal = faceNormal(oc, scope, face)
  const squareness = Math.abs(dot3(normal, fit.direction))
  // Not a cap at all: a side wall meeting the vertex stands square to the edge's
  // direction, and calling it consumed would name a face the blend never ends on.
  if (squareness < CAP_TILT_LIMIT) return null
  const square = squareness >= Math.cos(SQUARE_ANGULAR_TOL)
  const tiltDeg = (Math.acos(Math.min(1, squareness)) * 180) / Math.PI
  if (!square) return { at, extents: [NaN, NaN], square, tiltDeg }

  // The end face and an adjacent plane meet along one straight line through the
  // vertex, and that line is perpendicular to the edge (both planes contain the
  // edge, the end face is square to it). Its length is therefore exactly how far
  // the end face reaches in that direction, with no curve intersection needed.
  const extents: number[] = []
  for (const adjacent of fit.faces) {
    const boundary = edgesOf(oc, scope, face).find((edge) =>
      hasEdge(oc, scope, adjacent, edge) &&
      canonicalVertices(oc, scope, edge).some((v) => (v as OccSubShape).IsSame(vertex as OccSubShape)),
    )
    if (boundary === undefined) return null
    const ends = canonicalVertices(oc, scope, boundary)
    if (ends.length < 2) return null
    const a = vertexPoint(oc, scope, ends[0])
    const b = vertexPoint(oc, scope, ends[ends.length - 1])
    const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    if (!(length > 1e-9)) return null
    extents.push(length)
  }
  return { at, extents: [extents[0], extents[1]], square, tiltDeg }
}

/**
 * The end face the blend consumes at this end of the edge, if any: a face at
 * the vertex that is not one of the two adjacent planes, planar, and (when
 * square to the edge) reached at or before the setback along an adjacent face.
 * Several may qualify; the first in canonical face order is reported.
 */
export function consumedEndFace(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  edge: OccShape,
  spec: CornerBlendSpec,
  knownFit?: CornerFit,
): { fit: CornerFit; reach: EndFaceReach; limit: number } | null {
  const fit = knownFit ?? cornerFit(oc, scope, shape, edge, spec)
  if (fit === null) return null
  for (const vertex of canonicalVertices(oc, scope, edge) as OccShape[]) {
    for (const face of facesAtVertex(oc, scope, shape, vertex)) {
      if (fit.faces.some((adjacent) => (adjacent as OccSubShape).IsSame(face as OccSubShape))) continue
      const reach = endFaceReach(oc, scope, fit, face, vertex)
      if (reach === null) continue
      // A face that is not square to the edge is consumed at every size: the
      // blend does not end flat on it, so no extent bounds the cross-section.
      if (!reach.square) return { fit, reach, limit: NaN }
      const crossed = reach.extents.filter((extent, i) => fit.setbacks[i] >= extent - 1e-9 * Math.max(1, extent))
      if (crossed.length > 0) return { fit, reach, limit: Math.min(...crossed) }
    }
  }
  return null
}

/** The corner region to remove: the two face legs from the start vertex and the
 *  blend arc (fillet) or chord (chamfer) closing them. Extruded over the edge's
 *  exact length, so its end caps are flush with whatever caps the edge has. */
export function makeCornerTool(
  oc: OccModule,
  scope: DisposeScope,
  fit: CornerFit,
  spec: CornerBlendSpec,
): CornerTool | null {
  const { from, direction, inward, normals, setbacks } = fit
  const t1 = inward[0]
  const t2 = inward[1]
  const start = addScaled(from, t1, setbacks[0])
  const end = addScaled(from, t2, setbacks[1])
  let blend: OccShape
  if (spec.kind === 'fillet') {
    const radius = spec.radius
    const centre = addScaled(addScaled(from, t1, setbacks[0]), normals[0], -radius)
    const a1 = angleInFrame(sub3(start, centre), t1, direction)
    const a2 = angleInFrame(sub3(end, centre), t1, direction)
    const am = angleInFrame(sub3(from, centre), t1, direction)
    const throughStart = counterClockwise(a1, am) < counterClockwise(a1, a2)
    const [angleStart, angleEnd] = throughStart ? [a1, a2] : [a2, a1]
    blend = makeArcEdge(oc, scope, centre, direction, t1, radius, angleStart, angleEnd)
  } else {
    blend = makeLineEdge(oc, scope, start, end)
  }
  const legStart = makeLineEdge(oc, scope, from, start)
  const legEnd = makeLineEdge(oc, scope, end, from)
  const wire = makeWire(oc, scope, [legStart, blend, legEnd], { requireClosed: true })
  const face = makeFaceFromWire(oc, scope, wire)
  const vec = scope.track(new oc.gp_Vec_4(direction[0] * fit.length, direction[1] * fit.length, direction[2] * fit.length))
  const builder = scope.track(new oc.BRepPrimAPI_MakePrism_1(face, vec, true, true))
  const shape = scope.track(builder.Shape())
  if (!builder.IsDone() || countSolids(oc, scope, shape) !== 1) {
    scope.release(shape)
    return null
  }
  const blendFace = blendFaceOf(oc, scope, shape, direction, normals)
  if (blendFace === null) {
    scope.release(shape)
    return null
  }
  return { shape, blendFace }
}

/**
 * The tool face the cut leaves on the body. Prism `Generated()` is empty in
 * this binding (probed), and the prism rebuilds its profile edges, so the blend
 * edge cannot be matched either. The face is still identifiable by construction:
 * it is the lateral face that is neither a cap (its normal runs along the edge)
 * nor one of the two leg planes the corner sits between.
 */
function blendFaceOf(
  oc: OccModule,
  scope: DisposeScope,
  tool: OccShape,
  direction: Vec3,
  normals: [Vec3, Vec3],
): OccShape | null {
  const square = Math.cos(SQUARE_ANGULAR_TOL)
  const matches = facesOf(oc, scope, tool).filter((face) => {
    const n = faceNormal(oc, scope, face)
    if (Math.abs(dot3(n, direction)) >= square) return false
    return normals.every((leg) => Math.abs(dot3(n, leg)) < square)
  })
  return matches.length === 1 ? matches[0] : null
}

/** The angle of `v` around `axis` (the plane normal), measured from `xAxis`. */
function angleInFrame(v: Vec3, xAxis: Vec3, axis: Vec3): number {
  const yAxis: Vec3 = [
    axis[1] * xAxis[2] - axis[2] * xAxis[1],
    axis[2] * xAxis[0] - axis[0] * xAxis[2],
    axis[0] * xAxis[1] - axis[1] * xAxis[0],
  ]
  return Math.atan2(dot3(v, yAxis), dot3(v, xAxis))
}

function counterClockwise(from: number, to: number): number {
  const turn = (to - from) % (2 * Math.PI)
  return turn < 0 ? turn + 2 * Math.PI : turn
}
