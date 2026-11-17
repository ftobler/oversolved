// A body pick (a named ancestry query, a `@<body>/<kind>/<idx>` fallback, or a
// `face:`/`edge:` wrapper) mapped to a world primitive.
//
// A curved face is classified from `surface_type` and its analytic
// `surface_frame`, never from `face_data.normal`: that normal is the radial
// direction at the face centroid, not the axis, and reading it as a plane turns
// a hole into a plane at a plausible-looking distance.
import type { BodyResult } from '@/types/cad'
import { parseTopoFallbackQuery } from '@/utils/query/selectionId'
import type { MeasurePickRef } from '@/kernel/worker/solverProtocol'
import { normalize, type Primitive, type Vec3 } from '../primitives'

const TWO_PI = Math.PI * 2

interface PartElement {
  partId: string
  part: BodyResult
  kind: 'edge' | 'face' | 'vertex'
  index: number
}

/**
 * Resolve a selection id to a body + element kind + index. An EMPTY id names
 * nothing: the query arrays are padded with '' for entities the kernel could
 * not name, so a plain `indexOf('')` would resolve the first unnamed element.
 */
function findPartElement(id: string, parts: Record<string, BodyResult>): PartElement | null {
  if (!id) return null
  // Simple slash format names a BODY id, which is what `bodies` is keyed by, so
  // a split sibling's fallback query lands on the sibling the user picked.
  const parsed = parseTopoFallbackQuery(id)
  // `tri` is the legacy per-triangle highlight fallback: highlight-only, and a
  // triangle index is not a B-rep element index.
  if (parsed && parsed.kind !== 'tri') {
    const part = parts[parsed.partId]
    if (part) return { partId: parsed.partId, part, kind: parsed.kind, index: parsed.idx }
  }
  for (const [bodyId, body] of Object.entries(parts)) {
    const edge = body.edge_queries?.indexOf(id) ?? -1
    if (edge >= 0) return { partId: bodyId, part: body, kind: 'edge', index: edge }
    const face = body.mesh?.face_queries?.indexOf(id) ?? -1
    if (face >= 0) return { partId: bodyId, part: body, kind: 'face', index: face }
    const vertex = body.vertex_queries?.indexOf(id) ?? -1
    if (vertex >= 0) return { partId: bodyId, part: body, kind: 'vertex', index: vertex }
  }
  return null
}

/**
 * The kernel's name for a body-element pick: the body id plus the element's
 * index in that body's render arrays. Null when the id names no body element,
 * which is how a sketch or a datum pick stays out of a kernel request.
 */
export function partPickRef(
  id: string,
  parts: Record<string, BodyResult> | undefined,
): Extract<MeasurePickRef, { kind: 'face' | 'edge' | 'vertex' }> | null {
  if (!parts) return null
  const found = findPartElement(id, parts)
  if (!found) return null
  return { bodyId: found.partId, kind: found.kind, index: found.index }
}

export function partPrimitive(id: string, parts: Record<string, BodyResult> | undefined): Primitive | null {
  if (!parts) return null
  const found = findPartElement(id, parts)
  if (!found) return null
  const { part: body, kind, index } = found

  if (kind === 'vertex') {
    const vertex = body.vertices?.[index]
    return vertex ? { type: 'point', p: [...vertex] as Vec3 } : null
  }

  if (kind === 'edge') {
    const edge = body.edges?.[index]
    if (!edge) return null
    switch (edge.kind) {
      case 'line': {
        const p0 = [...edge.start] as Vec3
        const p1 = [...edge.end] as Vec3
        const dir = normalize([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]])
        return dir ? { type: 'line', p0, p1, dir, bounded: true } : null
      }
      case 'circle':
      case 'arc': {
        const axis = normalize(edge.axis)
        if (!axis) return null
        const sweep = edge.kind === 'circle' ? TWO_PI : Math.abs(edge.angle_end - edge.angle_start)
        return { type: 'circle', center: [...edge.center] as Vec3, axis, radius: edge.radius, sweep }
      }
      case 'ellipse': {
        const axis = normalize(edge.axis)
        if (!axis) return null
        // A full elliptical edge states its semi-axes; a partial one (a cylinder
        // cut, say) is an arc of that ellipse and its length is the kernel's
        // question, not a pair of parent-ellipse radii.
        const fullTurn = Math.abs(edge.angle_end - edge.angle_start) >= TWO_PI - 1e-9
        if (!fullTurn) return { type: 'opaque', what: 'partial ellipse edge', ref: id }
        return { type: 'ellipse', center: [...edge.center] as Vec3, axis, a: edge.a, b: edge.b }
      }
      case 'spline':
        return { type: 'opaque', what: 'spline edge', ref: id }
    }
  }

  const face = body.mesh?.face_data?.[index]
  if (!face) return null
  const opaqueFace = (what: string): Primitive => ({ type: 'opaque', what, ref: id })

  switch (face.surface_type) {
    case 'flatface':
    case undefined: {
      // A body solved before `surface_type` existed still has a meaningful
      // plane normal, so it keeps the flat-face reading.
      const normal = normalize(face.normal)
      if (!normal) return null
      return { type: 'plane', point: [...face.centroid] as Vec3, normal, bounded: true }
    }
    case 'cylinderface': {
      const frame = face.surface_frame
      const axis = frame ? normalize(frame.axis) : null
      if (!frame || !axis || frame.radius == null) return opaqueFace('cylinder face without an analytic frame')
      return { type: 'cylinder', axisPoint: [...frame.origin] as Vec3, axis, radius: frame.radius }
    }
    case 'coneface': {
      const frame = face.surface_frame
      const axis = frame ? normalize(frame.axis) : null
      if (!frame || !axis) return opaqueFace('cone face without an analytic frame')
      return {
        type: 'cone',
        axisPoint: [...frame.origin] as Vec3,
        axis,
        semiAngle: frame.semi_angle,
      }
    }
    case 'sphereface': {
      const frame = face.surface_frame
      if (!frame || frame.radius == null) return opaqueFace('sphere face without an analytic frame')
      return { type: 'sphere', center: [...frame.origin] as Vec3, radius: frame.radius }
    }
    case 'torusface': {
      const frame = face.surface_frame
      const axis = frame ? normalize(frame.axis) : null
      if (!frame || !axis) return opaqueFace('torus face without an analytic frame')
      return {
        type: 'torus',
        center: [...frame.origin] as Vec3,
        axis,
        majorRadius: frame.radius,
        minorRadius: frame.minor_radius,
      }
    }
    default:
      return opaqueFace(`${face.surface_type ?? 'freeform'} face`)
  }
}
