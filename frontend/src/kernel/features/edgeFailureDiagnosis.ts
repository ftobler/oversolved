// Why a fillet or chamfer refused, in words a user can act on. The kernel's
// own verdict is a bare `build_failed`, which cannot tell a radius that eats a
// whole face from a blend that runs tangentially into an edge nobody picked;
// the practice runs bisected 27-edge batches by hand to find the one edge
// (cast_bearing_unit F2) and tried ever smaller values that could never help
// (ppp0103 F1). Each diagnosis here measures the PRE-modifier shape and returns
// null when it cannot name a cause, so the caller keeps the kernel's reason.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccOrientedShape, OccShape, OccSubShape } from '../occ/occTypes'
import { canonicalEdges, canonicalVertices } from '../occ/bodyNames'
import { exploreEdges, exploreFaces } from '../occ/edgeModifier'
import { consumedEndFace, type CornerBlendSpec } from '../occ/cornerBlend'
import { endTangents } from './tangentChain'

type Vec3 = [number, number, number]

/** Whether `face` is bounded by `edge`. A face's edges are its own wrappers, so
 *  the match is `IsSame`, not object identity. */
function faceHasEdge(oc: OccModule, scope: DisposeScope, face: OccShape, edge: OccShape): boolean {
  return exploreEdges(oc, scope, face).some((fe) => (fe as OccSubShape).IsSame(edge as OccSubShape))
}

/** A straight edge's two end points, or null for a curved edge. */
function lineEnds(oc: OccModule, scope: DisposeScope, edge: OccShape): [Vec3, Vec3] | null {
  const curve = scope.track(new oc.BRepAdaptor_Curve_2(edge))
  if (curve.GetType().value !== oc.GeomAbs_CurveType.GeomAbs_Line.value) return null
  const vertices = canonicalVertices(oc, scope, edge)
  if (vertices.length < 2) return null
  const a = scope.track(oc.BRep_Tool.Pnt(vertices[0]))
  const b = scope.track(oc.BRep_Tool.Pnt(vertices[vertices.length - 1]))
  return [[a.X(), a.Y(), a.Z()], [b.X(), b.Y(), b.Z()]]
}

/** Distance from `p` to the line through `ends`. */
function distanceToLine(p: Vec3, ends: [Vec3, Vec3]): number {
  const [s, e] = ends
  const d = [e[0] - s[0], e[1] - s[1], e[2] - s[2]]
  const len = Math.hypot(d[0], d[1], d[2])
  if (!(len > 1e-12)) return NaN
  const r = [p[0] - s[0], p[1] - s[1], p[2] - s[2]]
  const along = (r[0] * d[0] + r[1] * d[1] + r[2] * d[2]) / len
  return Math.sqrt(Math.max(0, r[0] * r[0] + r[1] * r[1] + r[2] * r[2] - along * along))
}

/** The width of `face` measured ACROSS `edge`: the largest perpendicular
 *  distance from the edge's line to a vertex of the face. This is the strip a
 *  chamfer or fillet has to fit into. Null for a curved edge or a face with too
 *  few vertices; those have no single width, and a wrong number in an error is
 *  worse than none. */
export function faceWidthAcrossEdge(
  oc: OccModule,
  scope: DisposeScope,
  edge: OccShape,
  face: OccShape,
): number | null {
  const ends = lineEnds(oc, scope, edge)
  if (ends === null) return null
  let width = 0
  for (const v of canonicalVertices(oc, scope, face)) {
    const p = scope.track(oc.BRep_Tool.Pnt(v))
    const perp = distanceToLine([p.X(), p.Y(), p.Z()], ends)
    if (Number.isFinite(perp)) width = Math.max(width, perp)
  }
  return width > 1e-9 ? width : null
}

const shown = (n: number): number => Number(n.toPrecision(6))

/**
 * A chamfer whose distance cannot fit into an adjacent face. The message names
 * the measured width, which is what makes the fix obvious (0.25 on a 0.2 wall).
 */
export function chamferWidthDiagnosis(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  edges: OccShape[],
  distance: number,
): string | null {
  let narrowest: number | null = null
  for (const face of exploreFaces(oc, scope, shape)) {
    for (const edge of edges) {
      if (!faceHasEdge(oc, scope, face, edge)) continue
      const width = faceWidthAcrossEdge(oc, scope, edge, face)
      if (width !== null && (narrowest === null || width < narrowest)) narrowest = width
    }
  }
  if (narrowest === null || distance < narrowest - 1e-9) return null
  return `distance ${distance} meets or exceeds the adjacent face width ${shown(narrowest)} on the picked edge; use a smaller distance`
}

/**
 * A fillet radius that consumes a face. OCC's rolling-ball fillet cannot use a
 * face up entirely: between two picked parallel edges the limit is half the
 * face's width (the MCAD boxes stadium: r 10 on a 20 mm side), next to one
 * picked edge it is the whole width.
 */
export function filletWidthDiagnosis(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  edges: OccShape[],
  radius: number,
): string | null {
  let worst: { width: number; limit: number; between: boolean } | null = null
  for (const face of exploreFaces(oc, scope, shape)) {
    const own = edges.filter((edge) => faceHasEdge(oc, scope, face, edge))
    for (const edge of own) {
      const width = faceWidthAcrossEdge(oc, scope, edge, face)
      if (width === null) continue
      const ends = lineEnds(oc, scope, edge)!
      // Another picked edge on the same face, parallel and on its far side.
      const between = own.some((other) => {
        if (other === edge) return false
        const otherEnds = lineEnds(oc, scope, other)
        return otherEnds !== null
          && Math.abs(distanceToLine(otherEnds[0], ends) - width) < 1e-6 * Math.max(1, width)
          && Math.abs(distanceToLine(otherEnds[1], ends) - width) < 1e-6 * Math.max(1, width)
      })
      const limit = between ? width / 2 : width
      if (radius >= limit - 1e-9 && (worst === null || limit < worst.limit)) worst = { width, limit, between }
    }
  }
  if (worst === null) return null
  return worst.between
    ? `radius ${radius} consumes the ${shown(worst.width)} face between the picked edges; use < ${shown(worst.limit)} or a sketch arc`
    : `radius ${radius} consumes the ${shown(worst.width)} adjacent face; use < ${shown(worst.limit)}`
}

/**
 * A blend that runs past a small END face: a planar face that touches the
 * picked edge only at one of its vertices and that the blend would consume
 * whole. `filletWidthDiagnosis` measures only faces that CONTAIN the edge, so
 * this case fell through to the bare kernel refusal and the "try a smaller
 * radius" hint -- wrong advice twice over, because the end face is not the
 * radius the user asked for and a smaller radius is not the fix they want (the
 * enclosure practice run: the lip's 1.06 corner triangle refused every r above
 * 1.06, while r9 removes the overhang exactly).
 *
 * The message names the measured reach, which is what makes the sketch fix
 * obvious. A face that is not square to the edge has no such reach; it is
 * named without one rather than given a fabricated number.
 */
export function endFaceDiagnosis(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  edges: OccShape[],
  spec: CornerBlendSpec,
): string | null {
  const value = spec.kind === 'fillet' ? spec.radius : spec.distance
  for (const edge of edges) {
    const consumed = consumedEndFace(oc, scope, shape, edge, spec)
    if (consumed === null) continue
    const { reach, limit } = consumed
    const at = reach.at.map((c) => Number(c.toFixed(3)) + 0)
    const label = spec.kind === 'fillet' ? 'radius' : 'distance'
    const tail = 'or round the profile in the sketch (fillet_corners) before the extrude'
    if (!reach.square) {
      return `${label} ${shown(value)} consumes the end face at [${at.join(', ')}] ` +
        `(the picked edge ends on it, ${shown(reach.tiltDeg)} deg off square); ` +
        `square the face up to the edge, ${tail}`
    }
    return `${label} ${shown(value)} consumes the ${shown(limit)} end face at [${at.join(', ')}] ` +
      `(the picked edge ends on it); ${label} under ${shown(limit)} builds, ${tail}`
  }
  return null
}

/**
 * The unpicked edges a picked edge runs into tangentially (G1) at its ends. A
 * blend along such an edge has to stop dead where its neighbour carries on,
 * which the kernel can refuse at every size (ppp0103 F1: a half-boss arc
 * running into the plate's straight edges), where the fix is the pick, not the
 * value. A corner blend can also trip it and still build smaller, so callers
 * add this beside the kernel's reason, not instead of it.
 */
export function tangentNeighbourCount(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  edge: OccShape,
  picked: OccShape[],
): number {
  const own = endTangents(oc, scope, edge)
  let count = 0
  // The canonical (deduplicated) edge list: the raw explorer visits each edge
  // once per adjacent face and would count every neighbour twice.
  for (const other of canonicalEdges(oc, scope, shape)) {
    const sub = other as OccSubShape
    if (sub.IsSame(edge as OccSubShape) || picked.some((p) => sub.IsSame(p as OccSubShape))) continue
    const theirs = endTangents(oc, scope, other)
    const meets = own.some((a) => theirs.some((b) => {
      if (Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1], a.at[2] - b.at[2]) > 1e-6) return false
      const cross = [
        a.tangent[1] * b.tangent[2] - a.tangent[2] * b.tangent[1],
        a.tangent[2] * b.tangent[0] - a.tangent[0] * b.tangent[2],
        a.tangent[0] * b.tangent[1] - a.tangent[1] * b.tangent[0],
      ]
      return Math.hypot(cross[0], cross[1], cross[2]) < 1e-3
    }))
    if (meets) count++
  }
  return count
}

/**
 * The chain note for the edges a build refused. `edges` is what to diagnose;
 * `picked` is the whole pick set the build saw, and defaults to `edges` for
 * the all-in-one call. A refused edge's batch often picked its chain partners
 * even though the kernel skipped this one, so counting against `edges` alone
 * claimed "unpicked" edges the user had in fact picked (the practice F3
 * message). The skipped-edge caller passes the batch's resolved picks here.
 */
export function tangentChainDiagnosis(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  edges: OccShape[],
  picked: OccShape[] = edges,
): string | null {
  for (const edge of edges) {
    const n = tangentNeighbourCount(oc, scope, shape, edge, picked)
    if (n > 0) {
      return `the picked edge continues tangentially into ${n} unpicked edge(s) of the same chain; ` +
        'if a smaller value fails too, pick the whole tangent chain or blend the profile in the sketch'
    }
  }
  return null
}

/** How close to parallel two face normals must be before their shared edge is
 *  called a near-tangent corner. Below one degree the surfaces meet as a G1
 *  joint, so a rolling-ball blend has no corner to sit on. */
const NEAR_TANGENT_DEG = 1

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** The outward surface normal of `face` at the midpoint of `edge`, read from
 *  the edge's pcurve on that face so a curved face is sampled where it meets
 *  the edge rather than at its own UV midpoint. Null when the pcurve or the
 *  surface derivatives are degenerate; a failed read is no diagnosis. */
function faceNormalAtEdge(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  edge: OccShape,
): Vec3 | null {
  try {
    const c2d = scope.track(new oc.BRepAdaptor_Curve2d_2(edge, face))
    const t = (c2d.FirstParameter() + c2d.LastParameter()) / 2
    const uv = scope.track(c2d.Value(t))
    const u = uv.X()
    const v = uv.Y()
    const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
    const p = scope.track(new oc.gp_Pnt_1())
    const du = scope.track(new oc.gp_Vec_1())
    const dv = scope.track(new oc.gp_Vec_1())
    adaptor.D1(u, v, p, du, dv)
    const n: Vec3 = [
      du.Y() * dv.Z() - du.Z() * dv.Y(),
      du.Z() * dv.X() - du.X() * dv.Z(),
      du.X() * dv.Y() - du.Y() * dv.X(),
    ]
    const len = Math.hypot(n[0], n[1], n[2])
    if (!(len > 1e-12)) return null
    const unit = n.map(c => c / len) as Vec3
    const reversed = (face as OccOrientedShape).Orientation_1().value
      === oc.TopAbs_Orientation.TopAbs_REVERSED.value
    return reversed ? [-unit[0], -unit[1], -unit[2]] : unit
  } catch {
    return null
  }
}

/**
 * A picked edge whose two adjacent faces meet almost tangentially. OCC refuses
 * to roll a blend along such a joint at every radius because there is no corner
 * for the ball to sit in; the kernel's own verdict is the bare `build_failed`.
 * The practice F2 shape (a boss cylinder exactly swallowing a tube wall) and a
 * chord 0.5 mrad off a circle's tangent both end here. The angle is measured on
 * the pre-modifier shape, where the picked edge and both faces still exist.
 */
export function nearTangentCornerDiagnosis(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  edges: OccShape[],
): string | null {
  const faces = exploreFaces(oc, scope, shape)
  for (const edge of edges) {
    const adjacent = faces.filter(face => faceHasEdge(oc, scope, face, edge))
    if (adjacent.length !== 2) continue
    const [a, b] = adjacent
    if ((a as OccSubShape).IsSame(b as OccSubShape)) continue
    const na = faceNormalAtEdge(oc, scope, a, edge)
    const nb = faceNormalAtEdge(oc, scope, b, edge)
    if (na === null || nb === null) continue
    const deg = (Math.acos(Math.min(1, Math.max(-1, dot3(na, nb)))) * 180) / Math.PI
    if (deg > NEAR_TANGENT_DEG) continue
    const curve = scope.track(new oc.BRepAdaptor_Curve_2(edge))
    const p = curve.Value((curve.FirstParameter() + curve.LastParameter()) / 2)
    const at = [p.X(), p.Y(), p.Z()].map(c => Number(c.toFixed(3)) + 0)
    p.delete()
    const angle = deg < 0.01 ? '< 0.01' : String(Number(deg.toPrecision(3)))
    return `the picked edge meets an adjacent face at a near-tangent corner ` +
      `(${angle} deg at [${at.join(', ')}]); a fillet needs a real corner to round, ` +
      'so rebuild the joint or blend it in the sketch'
  }
  return null
}

/** A short label for an edge in a message: its kind and midpoint. */
export function edgeLabel(oc: OccModule, scope: DisposeScope, edge: OccShape): string {
  const curve = scope.track(new oc.BRepAdaptor_Curve_2(edge))
  const kind = curve.GetType().value === oc.GeomAbs_CurveType.GeomAbs_Line.value ? 'line' : 'curve'
  const p = curve.Value((curve.FirstParameter() + curve.LastParameter()) / 2)
  const mid = [p.X(), p.Y(), p.Z()].map((c) => Number(c.toFixed(3)) + 0)
  p.delete()
  return `${kind} at [${mid.join(', ')}]`
}
