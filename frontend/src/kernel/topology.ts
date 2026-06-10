// Port of oversolved/kernel/topology.py. Post-solve surface detection for sketch
// geometry: pairwise intersections -> entity splitting -> planar half-edge graph
// -> DCEL face-cycle traversal -> CCW bounded surfaces, plus per-edge/surface
// ancestry queries and line-division classifiers.
//
// Float parity: Python's float modulo takes the sign of the divisor; JS % takes
// the sign of the dividend, so angle wrapping uses pymod(). Transcendental
// results (atan2/sin/cos/hypot) can differ in the last bit cross-language, so
// the dual-run fixture compares coordinates within a tight tolerance while
// matching the identity-bearing query strings / structure exactly.

import {
  TOL_TOPOLOGY_EPS,
  TOL_TOPOLOGY_MERGE,
  TOL_TOPOLOGY_SPLIT,
} from "./solverConstants"
import { makeAncestryQuery, emitWire, absolute, parseAncestry } from "./query"
import { loopCentroid, classifyLoops } from "./profileLoops"
import { intersectCurves, type Curve } from "./curveIntersect"
import { subdivideBezier, ellipsePointAt, type BezierCtrl } from "./curveSplit"

const EPS = TOL_TOPOLOGY_EPS
const MERGE = TOL_TOPOLOGY_MERGE
const SPLIT_EPS = TOL_TOPOLOGY_SPLIT

const TWO_PI = 2 * Math.PI

export interface TopologyDict {
  intersection_points: Record<string, { x: number; y: number }>
  vertices: Record<string, { x: number; y: number }>
  edges: Record<string, unknown>[]
  surfaces: Record<string, unknown>[]
}

type Geom = Record<string, unknown>
type Pt = number[]
type EdgeGeom = Record<string, unknown>
// half-edge: [vfrom, vto, egeom]
type HalfEdge = [string, string, EdgeGeom]
// split point: [param, vertexId]
type Split = [number, string]

function radians(deg: number): number {
  return (deg * Math.PI) / 180
}
function degrees(rad: number): number {
  return (rad * 180) / Math.PI
}
/** Python float modulo (result takes the sign of the divisor). */
function pymod(a: number, b: number): number {
  return ((a % b) + b) % b
}

// ─── Geometry helpers ───

function angleInArc(aRad: number, startDeg: number, endDeg: number): boolean {
  const s = pymod(radians(startDeg), TWO_PI)
  const e = pymod(radians(endDeg), TWO_PI)
  const a = pymod(aRad, TWO_PI)
  if (Math.abs(s - e) < EPS || Math.abs(s - e) > TWO_PI - EPS) return true
  if (s < e) return s - EPS <= a && a <= e + EPS
  return a >= s - EPS || a <= e + EPS
}

function arcTangent(aRad: number, ccw = true): [number, number] {
  const s = ccw ? 1.0 : -1.0
  return [-s * Math.sin(aRad), s * Math.cos(aRad)]
}

// ─── Intersection primitives ───

function ll(p1: Pt, p2: Pt, p3: Pt, p4: Pt): [number, number, Pt] | null {
  const dx1 = p2[0] - p1[0]
  const dy1 = p2[1] - p1[1]
  const dx2 = p4[0] - p3[0]
  const dy2 = p4[1] - p3[1]
  const det = dx1 * dy2 - dy1 * dx2
  if (Math.abs(det) < EPS) return null
  const dx3 = p3[0] - p1[0]
  const dy3 = p3[1] - p1[1]
  let t = (dx3 * dy2 - dy3 * dx2) / det
  let u = (dx3 * dy1 - dy3 * dx1) / det
  if (!(-EPS <= t && t <= 1 + EPS && -EPS <= u && u <= 1 + EPS)) return null
  t = Math.max(0.0, Math.min(1.0, t))
  u = Math.max(0.0, Math.min(1.0, u))
  return [t, u, [p1[0] + t * dx1, p1[1] + t * dy1]]
}

function lc(p1: Pt, p2: Pt, cx: number, cy: number, r: number): [number, number, Pt][] {
  const dx = p2[0] - p1[0]
  const dy = p2[1] - p1[1]
  const fx = p1[0] - cx
  const fy = p1[1] - cy
  const a = dx * dx + dy * dy
  if (a < EPS) return []
  const b = 2 * (fx * dx + fy * dy)
  const c = fx * fx + fy * fy - r * r
  const disc = b * b - 4 * a * c
  if (disc < 0) return []
  const sd = Math.sqrt(Math.max(0.0, disc))
  const out: [number, number, Pt][] = []
  const seen = new Set<number>()
  for (const sign of [-1, 1]) {
    const raw = (-b + sign * sd) / (2 * a)
    if (!(-EPS <= raw && raw <= 1 + EPS)) continue
    const t = Math.max(0.0, Math.min(1.0, raw))
    const key = Math.round(t * 1e7) / 1e7
    if (seen.has(key)) continue
    seen.add(key)
    const ix = p1[0] + t * dx
    const iy = p1[1] + t * dy
    out.push([t, Math.atan2(iy - cy, ix - cx), [ix, iy]])
  }
  return out
}

function cc(
  cx1: number,
  cy1: number,
  r1: number,
  cx2: number,
  cy2: number,
  r2: number,
): [number, number, Pt][] {
  const d = Math.hypot(cx2 - cx1, cy2 - cy1)
  if (d < EPS || d > r1 + r2 + EPS || d < Math.abs(r1 - r2) - EPS) return []
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d)
  const h2 = r1 * r1 - a * a
  if (h2 < 0) return []
  const h = Math.sqrt(Math.max(0.0, h2))
  const mx = cx1 + (a * (cx2 - cx1)) / d
  const my = cy1 + (a * (cy2 - cy1)) / d
  const ox = (h * (cy2 - cy1)) / d
  const oy = (h * (cx2 - cx1)) / d
  let pts: Pt[] = [
    [mx + ox, my - oy],
    [mx - ox, my + oy],
  ]
  if (h < EPS) pts = pts.slice(0, 1)
  return pts.map(([sx, sy]) => [
    Math.atan2(sy - cy1, sx - cx1),
    Math.atan2(sy - cy2, sx - cx2),
    [sx, sy],
  ])
}

export function collinearOverlap(ea: Geom, eb: Geom): [number, number, Pt][] {
  const p1 = ea["start"] as Pt
  const p2 = ea["end"] as Pt
  const q1 = eb["start"] as Pt
  const q2 = eb["end"] as Pt

  const dx1 = p2[0] - p1[0]
  const dy1 = p2[1] - p1[1]
  const dx2 = q2[0] - q1[0]
  const dy2 = q2[1] - q1[1]

  if (Math.abs(dx1 * dy2 - dy1 * dx2) > EPS) return []

  const posCross = dx1 * (q1[1] - p1[1]) - dy1 * (q1[0] - p1[0])
  if (Math.abs(posCross) > EPS) return []

  const len1sq = dx1 * dx1 + dy1 * dy1
  if (len1sq < EPS) return []
  const projA = (pt: Pt) => ((pt[0] - p1[0]) * dx1 + (pt[1] - p1[1]) * dy1) / len1sq

  const len2sq = dx2 * dx2 + dy2 * dy2
  if (len2sq < EPS) return []
  const projB = (pt: Pt) => ((pt[0] - q1[0]) * dx2 + (pt[1] - q1[1]) * dy2) / len2sq

  let tb0 = projA(q1)
  let tb1 = projA(q2)
  if (tb0 > tb1) [tb0, tb1] = [tb1, tb0]

  const lo = Math.max(0.0, tb0)
  const hi = Math.min(1.0, tb1)
  if (hi - lo < SPLIT_EPS) return []

  const result: [number, number, Pt][] = []
  for (const [, pt] of [
    [0.0, q1],
    [1.0, q2],
  ] as [number, Pt][]) {
    const tA = projA(pt)
    if (tA > SPLIT_EPS && tA < 1 - SPLIT_EPS) result.push([tA, projB(pt), pt])
  }
  for (const [, pt] of [
    [0.0, p1],
    [1.0, p2],
  ] as [number, Pt][]) {
    const tb = projB(pt)
    if (tb > SPLIT_EPS && tb < 1 - SPLIT_EPS) result.push([projA(pt), tb, pt])
  }
  return result
}

function intersect(
  eidA: string,
  ea: Geom,
  eidB: string,
  eb: Geom,
  lines: Map<string, Geom>,
  circles: Map<string, Geom>,
): [number, number, Pt][] {
  const ta = lines.has(eidA) ? "l" : circles.has(eidA) ? "c" : "a"
  const tb = lines.has(eidB) ? "l" : circles.has(eidB) ? "c" : "a"

  const ia = (e: Geom, ang: number) =>
    angleInArc(ang, e["angle_start"] as number, e["angle_end"] as number)

  if (ta === "l" && tb === "l") {
    const r = ll(ea["start"] as Pt, ea["end"] as Pt, eb["start"] as Pt, eb["end"] as Pt)
    return r ? [[r[0], r[1], r[2]]] : []
  }
  if (ta === "l" && tb === "c") {
    return lc(ea["start"] as Pt, ea["end"] as Pt, (eb["center"] as Pt)[0], (eb["center"] as Pt)[1], eb["radius"] as number)
  }
  if (ta === "c" && tb === "l") {
    return lc(eb["start"] as Pt, eb["end"] as Pt, (ea["center"] as Pt)[0], (ea["center"] as Pt)[1], ea["radius"] as number).map(
      ([t, ang, pt]) => [ang, t, pt],
    )
  }
  if (ta === "l" && tb === "a") {
    return lc(ea["start"] as Pt, ea["end"] as Pt, (eb["center"] as Pt)[0], (eb["center"] as Pt)[1], eb["radius"] as number).filter(
      ([, ang]) => ia(eb, ang),
    )
  }
  if (ta === "a" && tb === "l") {
    return lc(eb["start"] as Pt, eb["end"] as Pt, (ea["center"] as Pt)[0], (ea["center"] as Pt)[1], ea["radius"] as number)
      .filter(([, ang]) => ia(ea, ang))
      .map(([t, ang, pt]) => [ang, t, pt])
  }
  const ccPts = () =>
    cc((ea["center"] as Pt)[0], (ea["center"] as Pt)[1], ea["radius"] as number, (eb["center"] as Pt)[0], (eb["center"] as Pt)[1], eb["radius"] as number)
  if (ta === "c" && tb === "c") return ccPts()
  if (ta === "c" && tb === "a") return ccPts().filter(([, a2]) => ia(eb, a2))
  if (ta === "a" && tb === "c") return ccPts().filter(([a1]) => ia(ea, a1))
  if (ta === "a" && tb === "a") return ccPts().filter(([a1, a2]) => ia(ea, a1) && ia(eb, a2))
  return []
}

// ─── Vertex registry ───

function vid(verts: Map<string, Pt>, pt: Pt): string {
  for (const [k, v] of verts) {
    if ((v[0] - pt[0]) ** 2 + (v[1] - pt[1]) ** 2 < MERGE ** 2) return k
  }
  const k = `_v${verts.size}`
  verts.set(k, [pt[0], pt[1]])
  return k
}

function hasParam(spl: Split[], p: number): boolean {
  return spl.some(([s]) => Math.abs(s - p) < SPLIT_EPS)
}

function normArcParam(p: number, a0: number): number {
  while (p < a0 - SPLIT_EPS) p += TWO_PI
  while (p >= a0 + TWO_PI - SPLIT_EPS) p -= TWO_PI
  return p
}

/** Sort splits by (param, vid), drop consecutive near-equal params. */
function dedup(spl: Split[]): Split[] {
  if (!spl.length) return spl
  const sorted = [...spl].sort((x, y) => (x[0] !== y[0] ? x[0] - y[0] : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0))
  const out: Split[] = [sorted[0]]
  for (const [p, v] of sorted.slice(1)) {
    if (Math.abs(p - out[out.length - 1][0]) > SPLIT_EPS) out.push([p, v])
  }
  return out
}

function buildEdgeQueries(hes: HalfEdge[], heEid: string[], featureId: string): Record<string, unknown>[] {
  const edges: Record<string, unknown>[] = []
  let edgeIdx = 0
  for (let i = 0; i < hes.length; i++) {
    if (i % 2 !== 0) continue
    const [v0, v1, eg] = hes[i]
    const eid = heEid[i]
    const edgeData: Geom = { ...eg, start_vertex: v0, end_vertex: v1 }
    const ancestorIds = [emitWire(absolute(featureId, eid)), `edge:${edgeIdx}`, emitWire(absolute(featureId))]
    const edgeType = eg["kind"] === "line" ? "straightedge" : "edge"
    const query = makeAncestryQuery(ancestorIds, edgeType)
    const entry: Record<string, unknown> = {
      query,
      entity_id: eid,
      edge_index: edgeIdx,
      start: edgeData["start"],
      end: edgeData["end"],
      kind: edgeData["kind"],
    }
    if ("center" in edgeData) {
      entry["center"] = edgeData["center"]
      entry["radius"] = edgeData["radius"]
    }
    edges.push(entry)
    edgeIdx += 1
  }
  return edges
}

// ─── Half-edge geometry constructors ───

function lineEg(e: Geom, t0: number, t1: number): EdgeGeom {
  const p1 = e["start"] as Pt
  const p2 = e["end"] as Pt
  const s = [p1[0] + t0 * (p2[0] - p1[0]), p1[1] + t0 * (p2[1] - p1[1])]
  const d = [p1[0] + t1 * (p2[0] - p1[0]), p1[1] + t1 * (p2[1] - p1[1])]
  return { kind: "line", start: s, end: d }
}

function arcEg(e: Geom, a0: number, a1: number, ccw = true): EdgeGeom {
  const cx = (e["center"] as Pt)[0]
  const cy = (e["center"] as Pt)[1]
  const r = e["radius"] as number
  return {
    kind: "arc",
    center: [cx, cy],
    radius: r,
    angle_start_deg: degrees(a0),
    angle_end_deg: degrees(a1),
    ccw,
    start: [cx + r * Math.cos(a0), cy + r * Math.sin(a0)],
    end: [cx + r * Math.cos(a1), cy + r * Math.sin(a1)],
  }
}

/** A cubic Bezier point at parameter t (P1, C1, C2, P4 control polygon). */
function bezierPoint(p1: Pt, c1: Pt, c2: Pt, p4: Pt, t: number): Pt {
  const mt = 1 - t
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t
  return [
    a * p1[0] + b * c1[0] + c * c2[0] + d * p4[0],
    a * p1[1] + b * c1[1] + c * c2[1] + d * p4[1],
  ]
}

/** Half-edge geometry for a spline (no internal splitting: endpoint-chained). */
function splineEg(e: Geom): EdgeGeom {
  return {
    kind: "spline",
    start: e["start"],
    end: e["end"],
    c1: e["c1"],
    c2: e["c2"],
  }
}

/** Half-edge geometry for a sub-Bezier of a spline cut at internal params. */
function subSplineEg(ctrl: BezierCtrl): EdgeGeom {
  return { kind: "spline", start: ctrl[0], c1: ctrl[1], c2: ctrl[2], end: ctrl[3] }
}

/** Elliptical-arc half-edge between two eccentric angles (mirrors arcEg). */
function ellipseArcEg(e: Geom, phi0: number, phi1: number, ccw = true): EdgeGeom {
  const c = e["center"] as Pt
  const a = e["a"] as number
  const b = e["b"] as number
  const theta = (e["theta"] as number) ?? 0.0
  return {
    kind: "ellipse_arc",
    center: [c[0], c[1]],
    a,
    b,
    theta,
    angle_start_deg: degrees(phi0),
    angle_end_deg: degrees(phi1),
    ccw,
    start: ellipsePointAt([c[0], c[1]], a, b, theta, phi0),
    end: ellipsePointAt([c[0], c[1]], a, b, theta, phi1),
  }
}

function rev(eg: EdgeGeom): EdgeGeom {
  if (eg["kind"] === "line") return { kind: "line", start: eg["end"], end: eg["start"] }
  if (eg["kind"] === "spline") {
    // Reverse the control polygon: swap endpoints and swap the handles.
    return { kind: "spline", start: eg["end"], end: eg["start"], c1: eg["c2"], c2: eg["c1"] }
  }
  if (eg["kind"] === "ellipse_arc") {
    return {
      ...eg,
      angle_start_deg: eg["angle_end_deg"],
      angle_end_deg: eg["angle_start_deg"],
      ccw: !((eg["ccw"] as boolean) ?? true),
      start: eg["end"],
      end: eg["start"],
    }
  }
  return {
    ...eg,
    angle_start_deg: eg["angle_end_deg"],
    angle_end_deg: eg["angle_start_deg"],
    ccw: !((eg["ccw"] as boolean) ?? true),
    start: eg["end"],
    end: eg["start"],
  }
}

function depart(egeom: EdgeGeom): number {
  if (egeom["kind"] === "line") {
    const s = egeom["start"] as Pt
    const d = egeom["end"] as Pt
    return Math.atan2(d[1] - s[1], d[0] - s[0])
  }
  if (egeom["kind"] === "spline") {
    // Departure tangent = Bezier derivative at t=0, i.e. direction start -> c1
    // (falling back to the chord toward end if the handle is coincident).
    const s = egeom["start"] as Pt
    const c1 = egeom["c1"] as Pt
    let dx = c1[0] - s[0], dy = c1[1] - s[1]
    if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) {
      const d = egeom["end"] as Pt
      dx = d[0] - s[0]; dy = d[1] - s[1]
    }
    return Math.atan2(dy, dx)
  }
  if (egeom["kind"] === "ellipse_arc") {
    // Departure tangent = dP/dphi at the start eccentric angle, in the traversal
    // direction, rotated into world by theta. P(phi)=C+Rot(theta)*(a cos, b sin).
    const a = egeom["a"] as number
    const b = egeom["b"] as number
    const th = radians((egeom["theta"] as number) ?? 0.0)
    const phi = radians(egeom["angle_start_deg"] as number)
    const s = ((egeom["ccw"] as boolean) ?? true) ? 1.0 : -1.0
    const dx = -a * Math.sin(phi) * s
    const dy = b * Math.cos(phi) * s
    return Math.atan2(dx * Math.sin(th) + dy * Math.cos(th), dx * Math.cos(th) - dy * Math.sin(th))
  }
  const a = radians(egeom["angle_start_deg"] as number)
  const [tx, ty] = arcTangent(a, (egeom["ccw"] as boolean) ?? true)
  return Math.atan2(ty, tx)
}

function faceArea(cycle: number[], hes: HalfEdge[], verts: Map<string, Pt>): number {
  const pts: Pt[] = []
  for (const i of cycle) {
    const [vf, , eg] = hes[i]
    pts.push(verts.get(vf)!)
    if (eg["kind"] === "spline") {
      // Sample interior Bezier points so the shoelace area follows the curve,
      // not the start->end chord (matches the arc midpoint treatment).
      const s = eg["start"] as Pt, c1 = eg["c1"] as Pt, c2 = eg["c2"] as Pt, e = eg["end"] as Pt
      for (let k = 1; k < 8; k++) pts.push(bezierPoint(s, c1, c2, e, k / 8))
    }
    if (eg["kind"] === "arc") {
      let a0 = radians(eg["angle_start_deg"] as number)
      let a1 = radians(eg["angle_end_deg"] as number)
      if (!((eg["ccw"] as boolean) ?? true)) [a0, a1] = [a1, a0]
      if (a1 < a0) a1 += TWO_PI
      const am = (a0 + a1) / 2
      const cx = (eg["center"] as Pt)[0]
      const cy = (eg["center"] as Pt)[1]
      const r = eg["radius"] as number
      pts.push([cx + r * Math.cos(am), cy + r * Math.sin(am)])
    }
    if (eg["kind"] === "ellipse_arc") {
      // Sample interior points start->end (in traversal order) so the shoelace
      // area follows the elliptical curve, not the chord.
      const c = eg["center"] as Pt
      const a = eg["a"] as number, b = eg["b"] as number
      const theta = (eg["theta"] as number) ?? 0.0
      const p0 = radians(eg["angle_start_deg"] as number)
      let p1 = radians(eg["angle_end_deg"] as number)
      const ccw = (eg["ccw"] as boolean) ?? true
      if (ccw) { if (p1 < p0) p1 += TWO_PI } else if (p1 > p0) p1 -= TWO_PI
      for (let k = 1; k < 8; k++) {
        pts.push(ellipsePointAt([c[0], c[1]], a, b, theta, p0 + ((p1 - p0) * k) / 8))
      }
    }
  }
  const n = pts.length
  let sum = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    sum += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
  }
  return sum / 2.0
}

// ─── Topology detection helpers ───

interface ClassifiedEntities {
  lines: Map<string, Geom>
  circles: Map<string, Geom>
  arcs: Map<string, Geom>
  splines: Map<string, Geom>
  ellipses: Map<string, Geom>
}

function classifyEntities(geometry: Geom): ClassifiedEntities {
  const lines = new Map<string, Geom>()
  const circles = new Map<string, Geom>()
  const arcs = new Map<string, Geom>()
  const splines = new Map<string, Geom>()
  const ellipses = new Map<string, Geom>()
  for (const [eid, e] of Object.entries(geometry)) {
    const ent = e as Geom
    if (ent["construction"]) continue
    // Spline/ellipse carry an explicit kind (both would otherwise be misread:
    // a spline has start/end like a line, a full ellipse has a center like a
    // circle). A full ellipse is a closed curve -> standalone area like a
    // circle; a spline is an open edge chained by its endpoints.
    if (ent["kind"] === "spline") splines.set(eid, ent)
    else if (ent["kind"] === "ellipse") ellipses.set(eid, ent)
    else if ("start" in ent && "radius" in ent) arcs.set(eid, ent)
    else if ("start" in ent) lines.set(eid, ent)
    else if ("center" in ent) circles.set(eid, ent)
  }
  return { lines, circles, arcs, splines, ellipses }
}

function normalizeArcsAndInitSplits(
  arcsIn: Map<string, Geom>,
  verts: Map<string, Pt>,
): [Map<string, number>, Map<string, Split[]>, Map<string, Geom>] {
  const arcs = new Map(arcsIn)
  const arcA0 = new Map<string, number>()
  const splits = new Map<string, Split[]>()

  for (const eid of [...arcs.keys()]) {
    const e = arcs.get(eid)!
    const a0Rad = radians(e["angle_start"] as number)
    const a1Rad = radians(e["angle_end"] as number)
    const ccwSpan = pymod(a1Rad - a0Rad, TWO_PI)
    if (ccwSpan > Math.PI + EPS) {
      arcs.set(eid, {
        ...e,
        angle_start: e["angle_end"],
        angle_end: e["angle_start"],
        start: e["end"],
        end: e["start"],
      })
    }
  }

  for (const [eid, e] of arcs) {
    const a0 = radians(e["angle_start"] as number)
    let a1 = radians(e["angle_end"] as number)
    a1 = normArcParam(a1, a0)
    arcA0.set(eid, a0)
    splits.set(eid, [
      [a0, vid(verts, e["start"] as Pt)],
      [a1, vid(verts, e["end"] as Pt)],
    ])
  }

  return [arcA0, splits, arcs]
}

function findAllIntersections(
  elist: [string, Geom][],
  lines: Map<string, Geom>,
  circles: Map<string, Geom>,
  splits: Map<string, Split[]>,
  verts: Map<string, Pt>,
  arcA0: Map<string, number>,
): Set<string> {
  const endpointVids = new Set(verts.keys())

  for (let i = 0; i < elist.length; i++) {
    const [eidA, ea] = elist[i]
    for (let j = i + 1; j < elist.length; j++) {
      const [eidB, eb] = elist[j]
      let results = intersect(eidA, ea, eidB, eb, lines, circles)
      if (!results.length && lines.has(eidA) && lines.has(eidB)) {
        results = collinearOverlap(ea, eb)
      }
      for (const r of results) {
        let pa = r[0]
        let pb = r[1]
        const pt = r[2]
        const v = vid(verts, pt)
        if (arcA0.has(eidA)) pa = normArcParam(pa, arcA0.get(eidA)!)
        if (arcA0.has(eidB)) pb = normArcParam(pb, arcA0.get(eidB)!)
        if (!hasParam(splits.get(eidA)!, pa)) splits.get(eidA)!.push([pa, v])
        if (!hasParam(splits.get(eidB)!, pb)) splits.get(eidB)!.push([pb, v])
      }
    }
  }

  const result = new Set<string>()
  for (const k of verts.keys()) if (!endpointVids.has(k)) result.add(k)
  return result
}

/** Topology geom dict -> the pure-intersection Curve form. */
function toCurve(kind: string, e: Geom): Curve {
  if (kind === "line") {
    const s = e["start"] as Pt
    const d = e["end"] as Pt
    return { kind: "line", p0: [s[0], s[1]], p1: [d[0], d[1]] }
  }
  if (kind === "circle" || kind === "arc") {
    const c = e["center"] as Pt
    return { kind: "circle", c: [c[0], c[1]], r: e["radius"] as number }
  }
  if (kind === "ellipse") {
    const c = e["center"] as Pt
    return { kind: "ellipse", c: [c[0], c[1]], a: e["a"] as number, b: e["b"] as number, theta: (e["theta"] as number) ?? 0.0 }
  }
  const s = e["start"] as Pt
  const c1 = e["c1"] as Pt
  const c2 = e["c2"] as Pt
  const d = e["end"] as Pt
  return { kind: "bezier", p0: [s[0], s[1]], c1: [c1[0], c1[1]], c2: [c2[0], c2[1]], p3: [d[0], d[1]] }
}

interface Tagged {
  eid: string
  e: Geom
  kind: string
}

/**
 * Augment `splits` with intersections that involve at least one ellipse or
 * spline (line/circle/arc-only pairs are handled by the legacy findAllIntersections).
 * Uses the pure curveIntersect kernel and maps each hit param into the per-kind
 * split convention (line t, circle/ellipse angle, arc normalized angle, spline t).
 */
function addCurveIntersections(
  tagged: Tagged[],
  splits: Map<string, Split[]>,
  verts: Map<string, Pt>,
  arcA0: Map<string, number>,
): void {
  const register = (entry: Tagged, t: number, v: string): void => {
    const spl = splits.get(entry.eid)
    if (!spl) return
    if (entry.kind === "line") {
      if (t < -EPS || t > 1 + EPS) return
      const tc = Math.max(0.0, Math.min(1.0, t))
      if (!hasParam(spl, tc)) spl.push([tc, v])
    } else if (entry.kind === "spline") {
      if (t <= SPLIT_EPS || t >= 1 - SPLIT_EPS) return  // endpoints already seeded
      if (!hasParam(spl, t)) spl.push([t, v])
    } else if (entry.kind === "circle") {
      // Match the legacy atan2 convention (-pi, pi] so a circle cut by both
      // passes keeps one consistent parameter range.
      const a = t > Math.PI ? t - TWO_PI : t
      if (!hasParam(spl, a)) spl.push([a, v])
    } else if (entry.kind === "ellipse") {
      if (!hasParam(spl, t)) spl.push([t, v])
    } else {
      // arc: keep only hits within the arc span, normalized like the legacy pass.
      if (!angleInArc(t, entry.e["angle_start"] as number, entry.e["angle_end"] as number)) return
      const p = normArcParam(t, arcA0.get(entry.eid) ?? 0)
      if (!hasParam(spl, p)) spl.push([p, v])
    }
  }

  for (let i = 0; i < tagged.length; i++) {
    for (let j = i + 1; j < tagged.length; j++) {
      const A = tagged[i]
      const B = tagged[j]
      const involvesCurve =
        A.kind === "ellipse" || A.kind === "spline" || B.kind === "ellipse" || B.kind === "spline"
      if (!involvesCurve) continue
      const hits = intersectCurves(toCurve(A.kind, A.e), toCurve(B.kind, B.e))
      for (const h of hits) {
        const v = vid(verts, h.point)
        register(A, h.tA, v)
        register(B, h.tB, v)
      }
    }
  }
}

function buildHalfEdgeGraph(
  lines: Map<string, Geom>,
  circles: Map<string, Geom>,
  arcs: Map<string, Geom>,
  splits: Map<string, Split[]>,
  splines: Map<string, Geom> = new Map(),
  ellipses: Map<string, Geom> = new Map(),
): [HalfEdge[], string[]] {
  const hes: HalfEdge[] = []
  const heEid: string[] = []
  const seenLines = new Set<string>()

  for (const [eid, e] of lines) {
    const spl = dedup(splits.get(eid)!)
    for (let k = 0; k < spl.length - 1; k++) {
      const [t0, v0] = spl[k]
      const [t1, v1] = spl[k + 1]
      if (v0 === v1) continue
      const key = `${v0}\x00${v1}`
      const rkey = `${v1}\x00${v0}`
      if (seenLines.has(key) || seenLines.has(rkey)) continue
      seenLines.add(key)
      seenLines.add(rkey)
      const eg = lineEg(e, t0, t1)
      hes.push([v0, v1, eg], [v1, v0, rev(eg)])
      heEid.push(eid, eid)
    }
  }

  for (const [eid, e] of arcs) {
    const spl = dedup(splits.get(eid)!)
    for (let k = 0; k < spl.length - 1; k++) {
      const [a0, v0] = spl[k]
      const [a1, v1] = spl[k + 1]
      if (v0 === v1) continue
      const eg = arcEg(e, a0, a1, true)
      hes.push([v0, v1, eg], [v1, v0, rev(eg)])
      heEid.push(eid, eid)
    }
  }

  for (const [eid, e] of circles) {
    const spl = dedup(splits.get(eid)!)
    if (spl.length < 2) continue
    for (let k = 0; k < spl.length; k++) {
      const [a0, v0] = spl[k]
      let [a1] = spl[(k + 1) % spl.length]
      const v1 = spl[(k + 1) % spl.length][1]
      if (v0 === v1) continue
      if (a1 <= a0) a1 += TWO_PI
      const eg = arcEg(e, a0, a1, true)
      hes.push([v0, v1, eg], [v1, v0, rev(eg)])
      heEid.push(eid, eid)
    }
  }

  // A full ellipse cut at >=2 eccentric angles becomes elliptical-arc sub-edges
  // around the loop (mirrors the circle arm). Uncut ellipses (<2 splits) stay
  // standalone -- see buildStandaloneEllipses.
  for (const [eid, e] of ellipses) {
    const spl = dedup(splits.get(eid) ?? [])
    if (spl.length < 2) continue
    for (let k = 0; k < spl.length; k++) {
      const [a0, v0] = spl[k]
      let [a1] = spl[(k + 1) % spl.length]
      const v1 = spl[(k + 1) % spl.length][1]
      if (v0 === v1) continue
      if (a1 <= a0) a1 += TWO_PI
      const eg = ellipseArcEg(e, a0, a1, true)
      hes.push([v0, v1, eg], [v1, v0, rev(eg)])
      heEid.push(eid, eid)
    }
  }

  // Splines split at internal intersection params into sub-Beziers (de
  // Casteljau); an uncut spline is a single endpoint-chained pair.
  for (const [eid, e] of splines) {
    const spl = dedup(splits.get(eid) ?? [])
    if (spl.length < 2) continue
    const ctrl: BezierCtrl = [
      e["start"] as [number, number],
      e["c1"] as [number, number],
      e["c2"] as [number, number],
      e["end"] as [number, number],
    ]
    for (let k = 0; k < spl.length - 1; k++) {
      const [t0, v0] = spl[k]
      const [t1, v1] = spl[k + 1]
      if (v0 === v1 || !(t1 > t0)) continue
      const eg = t0 <= 0 && t1 >= 1 ? splineEg(e) : subSplineEg(subdivideBezier(ctrl, t0, t1))
      hes.push([v0, v1, eg], [v1, v0, rev(eg)])
      heEid.push(eid, eid)
    }
  }

  return [hes, heEid]
}

function traceFaceCycles(
  hes: HalfEdge[],
  heEid: string[],
  verts: Map<string, Pt>,
  featureId: string,
): Record<string, unknown>[] {
  const surfaces: Record<string, unknown>[] = []
  if (!hes.length) return surfaces

  const outMap = new Map<string, [number, number][]>()
  for (let i = 0; i < hes.length; i++) {
    const [vf, , eg] = hes[i]
    const angle = depart(eg)
    if (!outMap.has(vf)) outMap.set(vf, [])
    outMap.get(vf)!.push([angle, i])
  }
  for (const outs of outMap.values()) {
    outs.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]))
  }

  // twin: i ^ 1; invariant check mirrors Python's assert
  for (let i = 0; i < hes.length; i += 2) {
    if (!(hes[i][0] === hes[i ^ 1][1] && hes[i][1] === hes[i ^ 1][0])) {
      throw new Error("half-edge twin invariant violated")
    }
  }

  const nextHe = new Map<number, number>()
  for (const outs of outMap.values()) {
    const k = outs.length
    for (let pos = 0; pos < outs.length; pos++) {
      const i = outs[pos][1]
      const ti = i ^ 1
      nextHe.set(ti, outs[((pos - 1) % k + k) % k][1])
    }
  }

  const visited = new Set<number>()
  for (let start = 0; start < hes.length; start++) {
    if (visited.has(start) || !nextHe.has(start)) continue
    const cycle: number[] = []
    let cur = start
    while (!visited.has(cur) && nextHe.has(cur)) {
      visited.add(cur)
      cycle.push(cur)
      cur = nextHe.get(cur)!
      if (cur === start) break
    }
    if (cycle.length && cur === start && faceArea(cycle, hes, verts) > 1e-10) {
      const absIds = cycle.map(i => emitWire(absolute(featureId, heEid[i]))).sort()
      const absIdsWithIndex = [...absIds, `surface:${surfaces.length}`, emitWire(absolute(featureId))]
      const query = makeAncestryQuery(absIdsWithIndex, "flatface")
      surfaces.push({
        boundary: cycle.map(i => ({
          ...hes[i][2],
          id: heEid[i],
          start_vertex: hes[i][0],
          end_vertex: hes[i][1],
        })),
        query,
      })
    }
  }

  return surfaces
}

function circleArcs(cx: number, cy: number, r: number, eid: string | null = null): Record<string, unknown>[] {
  return [
    {
      kind: "arc",
      center: [cx, cy],
      radius: r,
      angle_start_deg: 0.0,
      angle_end_deg: 180.0,
      ccw: true,
      start: [cx + r, cy],
      end: [cx - r, cy],
      start_vertex: null,
      end_vertex: null,
      id: eid,
    },
    {
      kind: "arc",
      center: [cx, cy],
      radius: r,
      angle_start_deg: 180.0,
      angle_end_deg: 360.0,
      ccw: true,
      start: [cx - r, cy],
      end: [cx + r, cy],
      start_vertex: null,
      end_vertex: null,
      id: eid,
    },
  ]
}

function buildStandaloneSurfaces(
  circles: Map<string, Geom>,
  splits: Map<string, Split[]>,
  featureId: string,
  surfacesSoFar = 0,
): Record<string, unknown>[] {
  const surfaces: Record<string, unknown>[] = []
  let surfCount = surfacesSoFar

  // Each uncut circle is a plain disk loop. Concentric nesting (disk-in-ring) is
  // resolved uniformly for every entity kind by nestSurfaces (even/odd holes).
  for (const [eid, e] of circles) {
    if (dedup(splits.get(eid) ?? []).length >= 2) continue
    const cx = (e["center"] as Pt)[0]
    const cy = (e["center"] as Pt)[1]
    const r = e["radius"] as number
    const ancestorIds = [emitWire(absolute(featureId, eid)), `surface:${surfCount}`, emitWire(absolute(featureId))]
    const query = makeAncestryQuery(ancestorIds, "flatface")
    surfaces.push({ boundary: circleArcs(cx, cy, r, eid), query })
    surfCount += 1
  }

  return surfaces
}

/**
 * Fold nested loops into outer+holes (the OCC face-with-holes model -- a donut
 * is one area with one inner loop). Delegates the even/odd containment nesting to
 * `classifyLoops` (the same engine the extrude path uses), then maps each outer
 * loop back to its source surface to keep that surface's ancestry query.
 */
function nestSurfaces(surfaces: Record<string, unknown>[]): Record<string, unknown>[] {
  if (surfaces.length < 2) return surfaces
  const loops = surfaces.map((s) => (s["boundary"] as Record<string, unknown>[]) ?? [])
  const out: Record<string, unknown>[] = []
  for (const [outer, holes] of classifyLoops(loops)) {
    const idx = loops.indexOf(outer)  // classifyLoops returns the same array refs
    const s = { ...surfaces[idx] }
    if (holes.length) s["holes"] = holes
    out.push(s)
  }
  return out
}

/**
 * Standalone areas for full (closed) ellipses, mirroring the standalone-circle
 * path. Each ellipse becomes one area whose boundary is a single closed ellipse
 * edge (the OCC face builder reads `kind:'ellipse'` and emits one curved edge).
 * Concentric nesting (ellipse-in-ellipse holes) is not modelled yet.
 */
function buildStandaloneEllipses(
  ellipses: Map<string, Geom>,
  splits: Map<string, Split[]>,
  featureId: string,
  surfacesSoFar = 0,
): Record<string, unknown>[] {
  const surfaces: Record<string, unknown>[] = []
  let surfCount = surfacesSoFar
  const seen: Pt[] = []  // [cx, cy, a, b, theta] of emitted ellipses, for dedup
  for (const [eid, e] of ellipses) {
    // A cut ellipse (>=2 splits) flows through the DCEL as elliptical arcs.
    if (dedup(splits.get(eid) ?? []).length >= 2) continue
    // Two geometrically identical full ellipses are one area, not two stacked.
    const c = e["center"] as Pt
    const key: Pt = [c[0], c[1], e["a"] as number, e["b"] as number, (e["theta"] as number) ?? 0]
    if (seen.some((k) => k.every((v, i) => Math.abs(v - key[i]) < MERGE))) continue
    seen.push(key)
    const ancestorIds = [emitWire(absolute(featureId, eid)), `surface:${surfCount}`, emitWire(absolute(featureId))]
    const query = makeAncestryQuery(ancestorIds, "flatface")
    const boundary = [{
      kind: "ellipse",
      center: e["center"],
      a: e["a"],
      b: e["b"],
      theta: e["theta"],
      start_vertex: null,
      end_vertex: null,
      id: eid,
    }]
    surfaces.push({ boundary, query })
    surfCount += 1
  }
  return surfaces
}

// ─── Geometric classifiers: line division ───

function lineSideTokens(surface: Record<string, unknown>): string[] {
  const boundary = (surface["boundary"] as Record<string, unknown>[]) ?? []
  const centroid = loopCentroid(boundary)
  const cx = centroid[0]
  const cy = centroid[1]
  const tokens = new Set<string>()
  for (const e of boundary) {
    if (e["kind"] !== "line") continue
    const eid = e["id"] as string | null | undefined
    const s = e["start"] as Pt | undefined
    const en = e["end"] as Pt | undefined
    if (!eid || !s || !en) continue
    const ends: [number, number][] = [
      [s[0], s[1]],
      [en[0], en[1]],
    ].sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1])) as [number, number][]
    const [x1, y1] = ends[0]
    const [x2, y2] = ends[1]
    const cross = (x2 - x1) * (cy - y1) - (y2 - y1) * (cx - x1)
    if (Math.abs(cross) < EPS) continue
    tokens.add("cls_ld_" + eid + (cross > 0 ? "_p" : "_n"))
  }
  return [...tokens].sort()
}

function attachLineDivisionClassifiers(surfaces: Record<string, unknown>[]): void {
  const groups = new Map<string, Record<string, unknown>[]>()
  for (const s of surfaces) {
    const q = (s["query"] as string) ?? ""
    if (!q.startsWith("?")) continue
    const [ids] = parseAncestry(q)
    const keyIds = ids.filter(i => i.startsWith("@") && i.includes("/"))
    const key = [...new Set(keyIds)].sort().join(" ")
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(s)
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    for (const s of group) {
      const tokens = lineSideTokens(s)
      if (!tokens.length) continue
      s["classifiers"] = tokens
      const [ids, t] = parseAncestry(s["query"] as string)
      s["query"] = makeAncestryQuery([...ids, ...tokens.map(tok => "@" + tok)], t)
    }
  }
}

// ─── Main entry point ───

export function detectTopology(geometry: Geom, featureId = ""): TopologyDict {
  const { lines, circles, arcs: arcsRaw, splines, ellipses } = classifyEntities(geometry)

  const verts = new Map<string, Pt>()
  const splits = new Map<string, Split[]>()
  const arcA0 = new Map<string, number>()

  for (const [eid, e] of lines) {
    splits.set(eid, [
      [0.0, vid(verts, e["start"] as Pt)],
      [1.0, vid(verts, e["end"] as Pt)],
    ])
  }

  for (const eid of circles.keys()) splits.set(eid, [])

  // Seed arc vertex registration with line-endpoint data so coincident arc/line
  // endpoints share vertex ids, then merge new arc vertices back.
  const arcVerts = new Map(verts)
  const [a0FromNorm, arcSplits, arcs] = normalizeArcsAndInitSplits(arcsRaw, arcVerts)
  for (const [k, v] of a0FromNorm) arcA0.set(k, v)
  for (const [k, v] of arcSplits) splits.set(k, v)
  for (const [k, v] of arcVerts) verts.set(k, v)

  // Spline endpoints register into the same vertex pool (vid merges by
  // position), so a spline that meets a line/arc at a coincident endpoint
  // shares its vertex and joins the loop. Internal splits are added by the
  // curve-intersection pass below.
  for (const [eid, e] of splines) {
    splits.set(eid, [
      [0.0, vid(verts, e["start"] as Pt)],
      [1.0, vid(verts, e["end"] as Pt)],
    ])
  }

  // Full ellipses are closed curves with no seeded endpoint (like circles).
  for (const eid of ellipses.keys()) splits.set(eid, [])

  // Snapshot endpoint vertices so the new intersection points (from either pass)
  // can be reported as such afterwards.
  const endpointVids = new Set(verts.keys())

  const elist: [string, Geom][] = [...lines, ...circles, ...arcs]
  findAllIntersections(elist, lines, circles, splits, verts, arcA0)

  // Second pass: every pair involving an ellipse or a spline, via the pure
  // curveIntersect kernel (conic-conic, conic-Bezier, Bezier-Bezier included).
  const tagged: Tagged[] = [
    ...[...lines].map(([eid, e]): Tagged => ({ eid, e, kind: "line" })),
    ...[...circles].map(([eid, e]): Tagged => ({ eid, e, kind: "circle" })),
    ...[...arcs].map(([eid, e]): Tagged => ({ eid, e, kind: "arc" })),
    ...[...ellipses].map(([eid, e]): Tagged => ({ eid, e, kind: "ellipse" })),
    ...[...splines].map(([eid, e]): Tagged => ({ eid, e, kind: "spline" })),
  ]
  addCurveIntersections(tagged, splits, verts, arcA0)

  const intersectionVids = new Set<string>()
  for (const k of verts.keys()) if (!endpointVids.has(k)) intersectionVids.add(k)

  const [hes, heEid] = buildHalfEdgeGraph(lines, circles, arcs, splits, splines, ellipses)

  let surfaces = traceFaceCycles(hes, heEid, verts, featureId)
  surfaces = surfaces.concat(buildStandaloneSurfaces(circles, splits, featureId, surfaces.length))
  surfaces = surfaces.concat(buildStandaloneEllipses(ellipses, splits, featureId, surfaces.length))
  // Fold disjoint nested loops (donut, holes in a face, islands) into outer+holes.
  surfaces = nestSurfaces(surfaces)
  attachLineDivisionClassifiers(surfaces)

  const intersectionPoints: Record<string, { x: number; y: number }> = {}
  for (const vidKey of intersectionVids) {
    const v = verts.get(vidKey)!
    intersectionPoints[vidKey] = { x: v[0], y: v[1] }
  }
  const verticesOut: Record<string, { x: number; y: number }> = {}
  for (const [vidKey, v] of verts) verticesOut[vidKey] = { x: v[0], y: v[1] }

  return {
    intersection_points: intersectionPoints,
    vertices: verticesOut,
    edges: buildEdgeQueries(hes, heEid, featureId),
    surfaces,
  }
}
