// Why a fillet or chamfer refused, in words a user can act on. The kernel's
// own verdict is a bare `build_failed`, which cannot tell a radius that eats a
// whole face from a blend that runs tangentially into an edge nobody picked;
// the practice runs bisected 27-edge batches by hand to find the one edge
// (cast_bearing_unit F2) and tried ever smaller values that could never help
// (ppp0103 F1). Each diagnosis here measures the PRE-modifier shape and returns
// null when it cannot name a cause, so the caller keeps the kernel's reason.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape } from '../occ/occTypes'
import { canonicalEdges, canonicalVertices } from '../occ/bodyNames'
import { exploreEdges, exploreFaces } from '../occ/edgeModifier'

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
    ? `radius ${radius} consumes the ${shown(worst.width)} mm face between the picked edges; use < ${shown(worst.limit)} or a sketch arc`
    : `radius ${radius} consumes the ${shown(worst.width)} mm adjacent face; use < ${shown(worst.limit)}`
}

/** The point and unit tangent at each end of an edge, sampled along the curve
 *  (the adaptor's D1 is not bound in this build). */
function endTangents(oc: OccModule, scope: DisposeScope, edge: OccShape): Array<{ at: Vec3; tangent: Vec3 }> {
  const curve = scope.track(new oc.BRepAdaptor_Curve_2(edge))
  const u0 = curve.FirstParameter()
  const u1 = curve.LastParameter()
  const h = (u1 - u0) * 1e-4
  const point = (u: number): Vec3 => {
    const p = curve.Value(u)
    const out: Vec3 = [p.X(), p.Y(), p.Z()]
    p.delete()
    return out
  }
  const ends: Array<{ at: Vec3; tangent: Vec3 }> = []
  for (const [u, step] of [[u0, h], [u1, -h]] as const) {
    const at = point(u)
    const next = point(u + step)
    const d: Vec3 = [next[0] - at[0], next[1] - at[1], next[2] - at[2]]
    const len = Math.hypot(d[0], d[1], d[2])
    if (len > 1e-15) ends.push({ at, tangent: [d[0] / len, d[1] / len, d[2] / len] })
  }
  return ends
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

export function tangentChainDiagnosis(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  edges: OccShape[],
): string | null {
  for (const edge of edges) {
    const n = tangentNeighbourCount(oc, scope, shape, edge, edges)
    if (n > 0) {
      return `the picked edge continues tangentially into ${n} unpicked edge(s) of the same chain; ` +
        'if a smaller value fails too, pick the whole tangent chain or blend the profile in the sketch'
    }
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
