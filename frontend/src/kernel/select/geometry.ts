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

/** The direction a parallel/perpendicular test compares: a line's chord, a
 *  curved edge's axis, a face's normal. */
export function directionOf(c: Candidate): Vec3 | null {
  if (c.kind === 'face') {
    const fd = c.body.mesh?.face_data?.[c.index]
    return fd ? normalize(fd.normal) : null
  }
  const ed = edgeData(c)
  if (!ed) return null
  switch (ed.kind) {
    case 'line':
      return normalize([ed.end[0] - ed.start[0], ed.end[1] - ed.start[1], ed.end[2] - ed.start[2]])
    case 'circle':
    case 'arc':
      return normalize(ed.axis)
    case 'ellipse':
      return normalize(ed.axis)
    case 'spline': {
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
