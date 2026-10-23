// The candidate model and its geometry accessors: the one place the engine
// reads a solved body's edge/face arrays. The arrays are positional and can
// come up short of their primitive list (the alignment trap documented in
// kernel/partBundle.ts), so every loop here is bounded by the PRIMITIVE array
// (`edges`, `face_data`) and reads the parallel query array defensively; a
// missing or empty query means the element is unnamed and cannot be selected.

import type { BodyResult, EdgeData } from '@/types/cad'
import type { SurfaceType } from '@/kernel/occ/primitives'
import type { EdgeGeometry, FaceGeometry, SelectKind, Vec3 } from './types'

/** One selectable element, resolved to its owning body and index. */
export interface Candidate {
  body: BodyResult
  bodyId: string
  kind: SelectKind
  index: number
  query: string
}

/** Normalize a vector; a degenerate input yields [0,0,0] so no direction test
 *  can match on a zero-length axis. */
export function normalize(v: readonly number[]): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2])
  if (len < 1e-15) return [0, 0, 0]
  return [v[0] / len, v[1] / len, v[2] / len]
}

export function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/** Cross product, used to rebuild a conic's in-plane y axis from its normal
 *  and x axis. */
function cross(a: readonly number[], b: readonly number[]): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

/** Every named edge of the bodies, in body-then-index order. */
export function edgeCandidates(bodies: Record<string, BodyResult>, from?: string): Candidate[] {
  const out: Candidate[] = []
  for (const bodyId of sortedBodyIds(bodies)) {
    if (from !== undefined && bodyId !== from) continue
    const body = bodies[bodyId]
    const edges = body.edges ?? []
    for (let index = 0; index < edges.length; index++) {
      const query = body.edge_queries?.[index] ?? ''
      if (!query) continue
      out.push({ body, bodyId, kind: 'edge', index, query })
    }
  }
  return out
}

/** Every named face of the bodies, in body-then-index order. */
export function faceCandidates(bodies: Record<string, BodyResult>, from?: string): Candidate[] {
  const out: Candidate[] = []
  for (const bodyId of sortedBodyIds(bodies)) {
    if (from !== undefined && bodyId !== from) continue
    const body = bodies[bodyId]
    const faceData = body.mesh?.face_data ?? []
    for (let index = 0; index < faceData.length; index++) {
      const query = body.mesh?.face_queries?.[index] ?? ''
      if (!query) continue
      out.push({ body, bodyId, kind: 'face', index, query })
    }
  }
  return out
}

/** Body ids sorted, so the output order does not depend on object key
 *  insertion: the same document and solve must yield the same list. */
export function sortedBodyIds(bodies: Record<string, BodyResult>): string[] {
  return Object.keys(bodies).sort()
}

function edgeData(c: Candidate): EdgeData | undefined {
  return c.body.edges?.[c.index]
}

// A curved analytic face carries a radial `normal` and its real axis in
// `surface_frame`; a flat face has no frame and its normal is the axis. These
// are the surface types where the axis is the meaningful direction.
const ANALYTIC_AXIS_SURFACES: ReadonlySet<string> = new Set(['cylinderface', 'coneface', 'torusface'])

const FULL_TURN = 2 * Math.PI

function isFullTurn(c: { angle_start: number; angle_end: number }): boolean {
  return Math.abs(c.angle_end - c.angle_start) >= FULL_TURN - 1e-9
}

/** A conic's tangent at the middle of its parametric sweep. The point is
 *  `center + a cos(t) x_axis + b sin(t) (axis x x_axis)`, so the tangent lies in
 *  the conic's plane: a fillet arc swept in the XZ plane is never parallel to
 *  Y, though its underlying circle's axis points along Y. */
function conicTangent(
  c: { axis: Vec3; x_axis: Vec3; angle_start: number; angle_end: number },
  a: number,
  b: number,
): Vec3 {
  const x = normalize(c.x_axis)
  const y = normalize(cross(c.axis, c.x_axis))
  const t = (c.angle_start + c.angle_end) / 2
  return normalize([
    -a * Math.sin(t) * x[0] + b * Math.cos(t) * y[0],
    -a * Math.sin(t) * x[1] + b * Math.cos(t) * y[1],
    -a * Math.sin(t) * x[2] + b * Math.cos(t) * y[2],
  ])
}

/** The direction a parallel/perpendicular test compares: an edge's own tangent
 *  (a line's direction, a conic's tangent at mid-sweep, a spline's tangent at
 *  its middle sample), a flat face's normal or a curved analytic face's axis
 *  (not its radial normal, which would make "parallel" mean a seam). A full
 *  circle has no single tangent, so it matches no direction clause. */
export function directionOf(c: Candidate): Vec3 | null {
  if (c.kind === 'face') {
    const fd = c.body.mesh?.face_data?.[c.index]
    if (!fd) return null
    const frame = fd.surface_frame
    if (frame !== undefined && ANALYTIC_AXIS_SURFACES.has(fd.surface_type ?? '')) return normalize(frame.axis)
    return normalize(fd.normal)
  }
  const ed = edgeData(c)
  if (!ed) return null
  switch (ed.kind) {
    case 'line':
      return normalize([ed.end[0] - ed.start[0], ed.end[1] - ed.start[1], ed.end[2] - ed.start[2]])
    case 'circle':
      // A full circle's tangent turns with the parameter, so there is no one
      // direction to compare; select it by type and radius instead.
      return null
    case 'arc':
      return isFullTurn(ed) ? null : conicTangent(ed, ed.radius, ed.radius)
    case 'ellipse':
      return isFullTurn(ed) ? null : conicTangent(ed, ed.a, ed.b)
    case 'spline': {
      // The middle sample's central difference is the curve's tangent there;
      // the first-to-last chord is only a fallback for a two-sample spline.
      const mid = Math.floor(ed.points.length / 2)
      const before = ed.points[mid - 1]
      const after = ed.points[mid + 1]
      if (before && after) {
        return normalize([after[0] - before[0], after[1] - before[1], after[2] - before[2]])
      }
      const first = ed.points[0]
      const last = ed.points[ed.points.length - 1]
      if (!first || !last) return null
      return normalize([last[0] - first[0], last[1] - first[1], last[2] - first[2]])
    }
  }
}

/** The point an `extreme` projection reads: a face centroid, a line midpoint,
 *  a curved edge's centre. */
export function pointOf(c: Candidate): Vec3 | null {
  if (c.kind === 'face') return c.body.mesh?.face_data?.[c.index]?.centroid ?? null
  const ed = edgeData(c)
  if (!ed) return null
  switch (ed.kind) {
    case 'line':
      return [(ed.start[0] + ed.end[0]) / 2, (ed.start[1] + ed.end[1]) / 2, (ed.start[2] + ed.end[2]) / 2]
    case 'circle':
    case 'arc':
      return ed.center
    case 'ellipse':
      return ed.center
    case 'spline': {
      const mid = ed.points[Math.floor(ed.points.length / 2)]
      return mid ?? null
    }
  }
}

/** The radius of a circle/arc edge or a cylinder face; null for anything a
 *  radius test cannot answer. */
export function radiusOf(c: Candidate): number | null {
  if (c.kind === 'face') {
    const fd = c.body.mesh?.face_data?.[c.index]
    if (fd?.surface_type !== 'cylinderface') return null
    return fd.surface_frame?.radius ?? null
  }
  const ed = edgeData(c)
  if (!ed) return null
  if (ed.kind === 'circle' || ed.kind === 'arc') return ed.radius
  return null
}

export function typeOf(c: Candidate): string | null {
  if (c.kind === 'face') return c.body.mesh?.face_data?.[c.index]?.surface_type ?? null
  return edgeData(c)?.kind ?? null
}

/** The axis-aligned bounding box of an element, for the `within` range test. */
export interface Bounds3 {
  min: Vec3
  max: Vec3
}

function boundsOfPoints(points: readonly Vec3[]): Bounds3 | null {
  if (points.length === 0) return null
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      if (p[i] < min[i]) min[i] = p[i]
      if (p[i] > max[i]) max[i] = p[i]
    }
  }
  return { min, max }
}

/** World half-extents of a full conic in its own plane. A circle of radius r
 *  with in-plane axes x and y reaches `r * sqrt(x[i]^2 + y[i]^2)` along world
 *  axis i, not r on every axis (a Y-axis cylinder's base circle is flat in Y). */
function conicHalfExtents(axis: Vec3, xAxis: Vec3, a: number, b: number): Vec3 {
  const x = normalize(xAxis)
  const y = normalize(cross(axis, xAxis))
  return [
    Math.hypot(a * x[0], b * y[0]),
    Math.hypot(a * x[1], b * y[1]),
    Math.hypot(a * x[2], b * y[2]),
  ]
}

function faceBounds(c: Candidate): Bounds3 | null {
  const mesh = c.body.mesh
  const triangles = mesh?.triangle_to_face
  if (!mesh || !triangles) return null
  const verts = mesh.vertices
  const faces = mesh.faces
  if (!verts || !faces) return null
  const vertexAt = (i: number): Vec3 => {
    if (verts instanceof Float32Array) return [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]]
    const v = (verts as [number, number, number][])[i]
    return [v[0], v[1], v[2]]
  }
  const triangleAt = (t: number): readonly number[] => {
    if (faces instanceof Uint32Array) return [faces[t * 3], faces[t * 3 + 1], faces[t * 3 + 2]]
    return (faces as [number, number, number][])[t]
  }
  const points: Vec3[] = []
  for (let t = 0; t < triangles.length; t++) {
    if (triangles[t] !== c.index) continue
    const tri = triangleAt(t)
    if (!tri) continue
    for (let k = 0; k < 3; k++) points.push(vertexAt(tri[k]))
  }
  return boundsOfPoints(points)
}

/** A line and a spline read their own points; a full conic is exact in its
 *  plane, while a partial arc uses its whole conic's bounds (conservative: a
 *  range that excludes the removed sweep can still exclude the arc). A face
 *  reads its mesh triangles; a solve without `triangle_to_face` has no face
 *  bounds and matches nothing. */
export function bboxOf(c: Candidate): Bounds3 | null {
  if (c.kind === 'face') return faceBounds(c)
  const ed = edgeData(c)
  if (!ed) return null
  switch (ed.kind) {
    case 'line':
      return boundsOfPoints([ed.start, ed.end])
    case 'circle':
    case 'arc': {
      const half = conicHalfExtents(ed.axis, ed.x_axis, ed.radius, ed.radius)
      return {
        min: [ed.center[0] - half[0], ed.center[1] - half[1], ed.center[2] - half[2]],
        max: [ed.center[0] + half[0], ed.center[1] + half[1], ed.center[2] + half[2]],
      }
    }
    case 'ellipse': {
      const half = conicHalfExtents(ed.axis, ed.x_axis, ed.a, ed.b)
      return {
        min: [ed.center[0] - half[0], ed.center[1] - half[1], ed.center[2] - half[2]],
        max: [ed.center[0] + half[0], ed.center[1] + half[1], ed.center[2] + half[2]],
      }
    }
    case 'spline':
      return boundsOfPoints(ed.points)
  }
}

// Every EdgeData kind, written as a Record so a new member of the union fails
// to compile here until the select vocabulary learns it.
const EDGE_KIND_SET: Record<EdgeData['kind'], true> = {
  line: true,
  circle: true,
  arc: true,
  spline: true,
  ellipse: true,
}

// Every SurfaceType, tethered the same way: a new member of the union fails to
// compile here until the vocabulary learns it. The `face` catch-all is included
// because typeOf reports it for a freeform face and `evaluate` accepts it. A
// type-only import keeps OCC out of this pure engine.
const FACE_TYPE_SET: Record<SurfaceType, true> = {
  flatface: true,
  cylinderface: true,
  coneface: true,
  sphereface: true,
  torusface: true,
  face: true,
}

const EDGE_KINDS: readonly string[] = Object.keys(EDGE_KIND_SET)
const FACE_TYPES: readonly string[] = Object.keys(FACE_TYPE_SET)

/** The `type` predicate vocabulary for a selector kind, read from the same
 *  tables as typeOf: edge kinds from the EdgeData union and face surface types
 *  from the SurfaceType union. */
export function typeVocabulary(kind: SelectKind): readonly string[] {
  return kind === 'edge' ? EDGE_KINDS : FACE_TYPES
}

// Common wrong spellings, mapped to the one vocabulary spelling. These are only
// a "did you mean" hint: matching stays exact, because one meaning has one
// spelling and a silent alias would hide the mistake instead of teaching it.
const TYPE_ALIASES: Readonly<Record<string, string>> = {
  plane: 'flatface',
  planar: 'flatface',
  plane_face: 'flatface',
  flat: 'flatface',
  cylinder: 'cylinderface',
  cylindrical: 'cylinderface',
  cylinder_face: 'cylinderface',
  cone: 'coneface',
  conical: 'coneface',
  sphere: 'sphereface',
  spherical: 'sphereface',
  torus: 'torusface',
  toroidal: 'torusface',
  line_segment: 'line',
  bezier: 'spline',
  bspline: 'spline',
  curve: 'spline',
}

// Levenshtein capped by the caller's threshold: a short typo (cylindeface), not
// an unrelated word. Duplicated from the mutation catalog deliberately: the
// select engine is a leaf and must not import the drive layer.
function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]
    previous[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j]
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return previous[b.length]
}

/** The vocabulary spelling a wrong `type` name most likely meant, or null when
 *  the name is valid or has no close candidate. An alias for the other kind is
 *  deliberately not suggested: `plane` is a face type, and telling an edge
 *  selector it meant `line` would hide that mistake. */
export function suggestTypeName(type: string, kind: SelectKind): string | null {
  const valid = typeVocabulary(kind)
  if (valid.includes(type)) return null
  const alias = TYPE_ALIASES[type.trim().toLowerCase()]
  if (alias !== undefined) return valid.includes(alias) ? alias : null
  let best: string | null = null
  let bestDistance = 3
  for (const candidate of valid) {
    const distance = editDistance(type, candidate)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/** The per-item geometry summary the agent reads back. */
export function geometryOf(c: Candidate): EdgeGeometry | FaceGeometry {
  if (c.kind === 'face') {
    const fd = c.body.mesh!.face_data![c.index]
    return {
      kind: 'face',
      surface_type: fd.surface_type ?? 'face',
      centroid: fd.centroid,
      normal: fd.normal,
      ...(fd.area !== undefined && { area: fd.area }),
      ...(fd.surface_frame?.radius !== undefined && { radius: fd.surface_frame.radius }),
      ...(fd.surface_frame?.axis !== undefined && { axis: fd.surface_frame.axis }),
    }
  }
  const ed = edgeData(c)!
  switch (ed.kind) {
    case 'line': {
      const length = Math.hypot(ed.end[0] - ed.start[0], ed.end[1] - ed.start[1], ed.end[2] - ed.start[2])
      return { kind: 'line', start: ed.start, end: ed.end, length }
    }
    case 'circle':
    case 'arc':
      return { kind: ed.kind, center: ed.center, radius: ed.radius, axis: ed.axis }
    case 'ellipse':
      return { kind: 'ellipse', center: ed.center, a: ed.a, b: ed.b, axis: ed.axis }
    case 'spline':
      return { kind: 'spline', point_count: ed.points.length }
  }
}
