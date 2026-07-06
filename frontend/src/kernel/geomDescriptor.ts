// Geometric descriptor tokens: the tolerant successor to geom-hash digest tokens
// in persisted ancestry queries (feature: query-descriptor-identity).
//
// A digest (`@gface_<sha16>`) can only answer "exactly equal", so any centroid
// drift -- a dimension edit, a kernel version bump, a 4dp rounding flip -- kills
// the token. A descriptor token carries the rounded geometry itself, so the
// resolver can ask "which candidate is *closest*, and is the match unambiguous?"
// Geom hashes remain the internal lineage-map keys (`face_lineage`/`edge_lineage`)
// and the legacy resolution registry; only persisted query tokens use descriptors.
//
// Wire formats (numbers via pyRound4Str, the 4dp shortest-repr formatter):
//   @gdf|cx,cy,cz|nx,ny,nz              face: centroid + outward normal
//   @gde|<kind>|px,py,pz|ax,ay,az|s     edge: representative point + axis + scalar
//   @gdv|x,y,z                          vertex: the point
//
// Derivation stability matters like hash stability did, but with tolerance
// slack: small numeric drift is absorbed by matching; a *representation* change
// (e.g. arc midpoint -> arc center) would strand persisted tokens, so the
// per-kind derivation below is part of the persisted contract.

import { pyRound4Str } from "./geomHash"

export interface FaceDescriptor {
  kind: "face"
  point: number[]  // centroid
  axis: number[]   // outward normal (signed at match time)
}
export interface EdgeDescriptor {
  kind: "edge"
  edgeKind: string  // line | circle | arc | ellipse | spline | ...
  point: number[]   // representative point (see derivation per kind)
  axis: number[]    // direction / rotation axis (sign-insensitive at match time)
  scalar: number    // length / radius / semi-major axis
}
export interface VertexDescriptor {
  kind: "vertex"
  point: number[]
}
export type GeomDescriptor = FaceDescriptor | EdgeDescriptor | VertexDescriptor

const FACE_PREFIX = "@gdf|"
const EDGE_PREFIX = "@gde|"
const VERTEX_PREFIX = "@gdv|"

/** Wire-format descriptor token (@gdf|/@gde|/@gdv|). */
export function isGeomDescriptorId(idStr: string): boolean {
  return (
    idStr.startsWith(FACE_PREFIX) ||
    idStr.startsWith(EDGE_PREFIX) ||
    idStr.startsWith(VERTEX_PREFIX)
  )
}

function nums(v: number[]): string {
  return v.map(pyRound4Str).join(",")
}

export function emitFaceDescriptor(centroid: number[], normal: number[]): string {
  return FACE_PREFIX + nums(centroid) + "|" + nums(normal)
}

export function emitEdgeDescriptor(d: EdgeDescriptor): string {
  return EDGE_PREFIX + d.edgeKind + "|" + nums(d.point) + "|" + nums(d.axis) + "|" + pyRound4Str(d.scalar)
}

export function emitVertexDescriptor(pt: number[]): string {
  return VERTEX_PREFIX + nums(pt)
}

function parseNums(s: string): number[] | null {
  const parts = s.split(",")
  const out: number[] = []
  for (const p of parts) {
    const v = Number(p)
    if (!Number.isFinite(v)) return null
    out.push(v)
  }
  return out
}

/** Parse a descriptor token; null on anything malformed (fail-safe: an
 *  unparseable token simply never narrows, it does not throw). */
export function parseGeomDescriptorId(idStr: string): GeomDescriptor | null {
  if (idStr.startsWith(FACE_PREFIX)) {
    const parts = idStr.slice(FACE_PREFIX.length).split("|")
    if (parts.length !== 2) return null
    const point = parseNums(parts[0])
    const axis = parseNums(parts[1])
    if (!point || !axis || point.length !== 3 || axis.length !== 3) return null
    return { kind: "face", point, axis }
  }
  if (idStr.startsWith(EDGE_PREFIX)) {
    const parts = idStr.slice(EDGE_PREFIX.length).split("|")
    if (parts.length !== 4) return null
    const point = parseNums(parts[1])
    const axis = parseNums(parts[2])
    const scalar = Number(parts[3])
    if (!parts[0] || !point || !axis || point.length !== 3 || axis.length !== 3 || !Number.isFinite(scalar)) {
      return null
    }
    return { kind: "edge", edgeKind: parts[0], point, axis, scalar }
  }
  if (idStr.startsWith(VERTEX_PREFIX)) {
    const point = parseNums(idStr.slice(VERTEX_PREFIX.length))
    if (!point || point.length !== 3) return null
    return { kind: "vertex", point }
  }
  return null
}

// ─── Derivation ───

function sub(a: number[], b: number[]): number[] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
function norm(v: number[]): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
}
function normalize(v: number[]): number[] {
  const n = norm(v)
  if (n < 1e-12) return [0, 0, 0]
  return [v[0] / n, v[1] / n, v[2] / n]
}
function cross(a: number[], b: number[]): number[] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}
function dot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function asVec(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length !== 3) return null
  const out = v.map(Number)
  return out.every(Number.isFinite) ? out : null
}

/** Angle in radians from a payload that may carry radians or degrees. */
function edgeAngle(edge: Record<string, unknown>, start: boolean): number {
  const degKey = start ? "angle_start_deg" : "angle_end_deg"
  const radKey = start ? "angle_start" : "angle_end"
  if (degKey in edge) return (Number(edge[degKey]) * Math.PI) / 180
  if (radKey in edge) return Number(edge[radKey])
  return 0
}

/** Point on a conic at parametric angle t: center + a*cos(t)*x + b*sin(t)*y. */
function conicPoint(
  center: number[],
  xAxis: number[],
  yAxis: number[],
  a: number,
  b: number,
  t: number,
): number[] {
  const c = Math.cos(t)
  const s = Math.sin(t)
  return [
    center[0] + a * c * xAxis[0] + b * s * yAxis[0],
    center[1] + a * c * xAxis[1] + b * s * yAxis[1],
    center[2] + a * c * xAxis[2] + b * s * yAxis[2],
  ]
}

/**
 * Derive the persisted edge descriptor from an edge data dict (the shape
 * `solidToEdges` emits and `edgeAncestryPayload` registers). Per-kind
 * derivation is part of the persisted contract (see module header):
 *   line     midpoint, unit direction, length
 *   circle   center, axis, radius
 *   arc      arc midpoint, axis, radius
 *   ellipse  center (arc midpoint when partial), axis, semi-major `a`
 *   spline   mean of points, unit chord direction, chord length
 * Returns null when the dict lacks the geometry (fail-safe: no descriptor,
 * no narrowing).
 */
export function edgeDescriptorOf(edge: Record<string, unknown>): EdgeDescriptor | null {
  const kind = typeof edge["kind"] === "string" ? (edge["kind"] as string) : ""
  if (kind === "line") {
    const start = asVec(edge["start"])
    const end = asVec(edge["end"])
    if (!start || !end) return null
    const dir = normalize(sub(end, start))
    return {
      kind: "edge",
      edgeKind: "line",
      point: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2],
      axis: dir,
      scalar: norm(sub(end, start)),
    }
  }
  if (kind === "circle" || kind === "arc") {
    const center = asVec(edge["center"])
    const radius = Number(edge["radius"])
    if (!center || !Number.isFinite(radius)) return null
    // Axis is essential geometry, not a test-harness default: a missing axis
    // means the payload is malformed, and emitting a world-axis fallback would
    // let it match an unrelated world-axis query silently.
    const axis = asVec(edge["axis"])
    if (axis === null) return null
    if (kind === "circle") {
      return { kind: "edge", edgeKind: "circle", point: center, axis, scalar: radius }
    }
    const xAxis = asVec(edge["x_axis"])
    if (xAxis === null) return null
    const yAxis = cross(axis, xAxis)
    const mid = (edgeAngle(edge, true) + edgeAngle(edge, false)) / 2
    return {
      kind: "edge",
      edgeKind: "arc",
      point: conicPoint(center, xAxis, yAxis, radius, radius, mid),
      axis,
      scalar: radius,
    }
  }
  if (kind === "ellipse") {
    const center = asVec(edge["center"])
    const a = Number(edge["a"])
    const b = Number(edge["b"])
    if (!center || !Number.isFinite(a)) return null
    const axis = asVec(edge["axis"])
    if (axis === null) return null
    const t0 = edgeAngle(edge, true)
    const t1 = edgeAngle(edge, false)
    // A full ellipse (or missing range) anchors on the center; a partial
    // elliptical arc anchors on its midpoint so two arcs of one ellipse differ.
    // The 1e-6 window rides above 4dp rounding jitter, so a near-full ellipse
    // (span 2*pi - 1e-7) does not flip to the midpoint anchor and strand tokens
    // across rebuilds.
    const full = Math.abs(Math.abs(t1 - t0) - 2 * Math.PI) < 1e-6 || t0 === t1
    if (full) return { kind: "edge", edgeKind: "ellipse", point: center, axis, scalar: a }
    // Partial elliptical arc: midpoint anchor needs `b` and the plane's x_axis.
    // A payload missing them cannot distinguish two arcs of one ellipse, so we
    // refuse to emit (fail-safe over a colliding center anchor).
    if (!Number.isFinite(b)) return null
    const xAxis = asVec(edge["x_axis"])
    if (xAxis === null) return null
    const point = conicPoint(center, xAxis, cross(axis, xAxis), a, b, (t0 + t1) / 2)
    return { kind: "edge", edgeKind: "ellipse", point, axis, scalar: a }
  }
  // Spline and anything else that carries sampled points: mean point + chord.
  const points = edge["points"]
  if (Array.isArray(points) && points.length >= 2) {
    const pts = points.map(asVec)
    if (pts.some((p) => p === null)) return null
    const mean = [0, 0, 0]
    for (const p of pts as number[][]) {
      mean[0] += p[0]
      mean[1] += p[1]
      mean[2] += p[2]
    }
    mean[0] /= pts.length
    mean[1] /= pts.length
    mean[2] /= pts.length
    const first = pts[0] as number[]
    const last = pts[pts.length - 1] as number[]
    return {
      kind: "edge",
      edgeKind: kind || "spline",
      point: mean,
      axis: normalize(sub(last, first)),
      scalar: norm(sub(last, first)),
    }
  }
  const start = asVec(edge["start"])
  const end = asVec(edge["end"])
  if (start && end) {
    return {
      kind: "edge",
      edgeKind: kind || "spline",
      point: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2],
      axis: normalize(sub(end, start)),
      scalar: norm(sub(end, start)),
    }
  }
  return null
}

/**
 * Descriptor of a registered repository element (the payloads
 * `_registerBrepFaceAncestry` / `edgeAncestryPayload` /
 * `_registerBrepVertexAncestry` build). Null when the payload carries no
 * usable geometry -- such a candidate is simply outside the descriptor
 * tier's reach.
 */
export function descriptorOfElement(el: unknown): GeomDescriptor | null {
  if (el === null || typeof el !== "object" || Array.isArray(el)) return null
  const d = el as Record<string, unknown>
  const centroid = asVec(d["centroid"])
  const normal = asVec(d["normal"])
  if (centroid && normal) return { kind: "face", point: centroid, axis: normal }
  if (d["type"] === "vertex") {
    const origin = asVec(d["origin"])
    return origin ? { kind: "vertex", point: origin } : null
  }
  if (typeof d["kind"] === "string") return edgeDescriptorOf(d)
  return null
}

// ─── Matching ───

export interface DescriptorMatchConfig {
  // position window for a "same entity, numeric jitter" match (mm).
  tightTol: number
  // minimum signed normal alignment for face candidates (cos of max angle).
  normalDotMin: number
  // minimum |axis alignment| for edge candidates (direction sign is
  // rebuild-unstable, so the edge gate is sign-insensitive).
  axisDotMin: number
  // outside the tight window, the nearest candidate wins only when the
  // runner-up is at least this factor farther (fail-safe: near-ties refuse).
  ratioMargin: number
}

export const DEFAULT_DESCRIPTOR_MATCH: DescriptorMatchConfig = {
  tightTol: 1e-3,
  normalDotMin: 0.999,
  axisDotMin: 0.999,
  ratioMargin: 2.0,
}

/**
 * Distance between a query descriptor and a candidate descriptor, or null when
 * the candidate fails the kind/orientation gate. Edges fold the scalar
 * difference into the distance so two coaxial circles of different radius
 * stay distinguishable.
 */
export function descriptorDistance(
  q: GeomDescriptor,
  c: GeomDescriptor,
  cfg: DescriptorMatchConfig = DEFAULT_DESCRIPTOR_MATCH,
): number | null {
  if (q.kind !== c.kind) return null
  if (q.kind === "face" && c.kind === "face") {
    if (dot(q.axis, c.axis) < cfg.normalDotMin) return null
    return norm(sub(q.point, c.point))
  }
  if (q.kind === "edge" && c.kind === "edge") {
    if (q.edgeKind !== c.edgeKind) return null
    if (Math.abs(dot(q.axis, c.axis)) < cfg.axisDotMin) return null
    return norm(sub(q.point, c.point)) + Math.abs(q.scalar - c.scalar)
  }
  return norm(sub(q.point, c.point))  // vertex
}

/**
 * Narrow a candidate list by one query descriptor. Tiers, all graceful
 * (an empty outcome returns the input unchanged rather than wiping it):
 *   1. kind/orientation gate (inside descriptorDistance)
 *   2. tight window -- every candidate within tightTol survives (several
 *      tight hits stay ambiguous for the caller to fail loud on)
 *   3. nearest-with-margin -- the closest candidate wins only when the
 *      runner-up is >= ratioMargin farther; a near-tie keeps the gated set
 * Returns [candidateId, distance|null] pairs' ids.
 */
export function narrowByDescriptor<T>(
  q: GeomDescriptor,
  candidates: Array<[T, GeomDescriptor | null]>,
  cfg: DescriptorMatchConfig = DEFAULT_DESCRIPTOR_MATCH,
): T[] {
  const gated: Array<[T, number]> = []
  for (const [id, desc] of candidates) {
    if (desc === null) continue
    const d = descriptorDistance(q, desc, cfg)
    if (d !== null) gated.push([id, d])
  }
  if (gated.length === 0) return candidates.map(([id]) => id)
  const tight = gated.filter(([, d]) => d <= cfg.tightTol)
  if (tight.length) return tight.map(([id]) => id)
  gated.sort((a, b) => a[1] - b[1])
  if (gated.length === 1 || gated[0][1] * cfg.ratioMargin <= gated[1][1]) {
    return [gated[0][0]]
  }
  return gated.map(([id]) => id)
}

/**
 * Strict single-winner variant for consumers that actuate on the result
 * (fillet/chamfer resolve an edge and cut metal): exactly one tight hit, or
 * a nearest with clear margin -- anything ambiguous returns undefined instead
 * of gracefully passing candidates through.
 */
export function bestDescriptorMatch<T>(
  q: GeomDescriptor,
  candidates: Array<[T, GeomDescriptor | null]>,
  cfg: DescriptorMatchConfig = DEFAULT_DESCRIPTOR_MATCH,
): T | undefined {
  const gated: Array<[T, number]> = []
  for (const [id, desc] of candidates) {
    if (desc === null) continue
    const d = descriptorDistance(q, desc, cfg)
    if (d !== null) gated.push([id, d])
  }
  if (gated.length === 0) return undefined
  const tight = gated.filter(([, d]) => d <= cfg.tightTol)
  if (tight.length === 1) return tight[0][0]
  if (tight.length > 1) return undefined
  gated.sort((a, b) => a[1] - b[1])
  if (gated.length === 1 || gated[0][1] * cfg.ratioMargin <= gated[1][1]) {
    return gated[0][0]
  }
  return undefined
}
