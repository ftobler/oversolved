// A body pick (a named ancestry query, a `@<body>/<kind>/<idx>` fallback, or a
// `face:`/`edge:` wrapper) mapped to a world primitive.
//
// A curved face is classified from `surface_type` and its analytic
// `surface_frame`, never from `face_data.normal`: that normal is the radial
// direction at the face centroid, not the axis, and reading it as a plane turns
// a hole into a plane at a plausible-looking distance.
import type { EdgeData, FaceData, Mesh3D, PartResult } from '@/types/cad'
import { parseTopoFallbackQuery } from '@/utils/query/selectionId'
import type { MeasurePickRef } from '@/kernel/worker/solverProtocol'
import { OCC_CONFUSION } from '@/kernel/solverConstants'
import { dot, sub } from '@/utils/vec3'
import { normalize, pointToAxisDistance, type Primitive, type Vec3 } from '../primitives'

const TWO_PI = Math.PI * 2
// A planar face counts as a disc or a ring when its tessellated area is within
// this fraction of the analytic value. The area on `face_data` is summed from
// triangles, so it sits slightly inside a curved boundary; Möbius accepts the
// same 2 percent for the same reason.
const CIRCULAR_FACE_AREA_TOLERANCE = 0.02

interface PartElement {
  partId: string
  part: PartResult
  kind: 'edge' | 'face' | 'vertex'
  index: number
}

/**
 * Resolve a selection id to a body + element kind + index. An EMPTY id names
 * nothing: the query arrays are padded with '' for entities the kernel could
 * not name, so a plain `indexOf('')` would resolve the first unnamed element.
 */
function findPartElement(id: string, parts: Record<string, PartResult>): PartElement | null {
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
 * The kernel's linear contract scaled by the radius: two arcs of one circle
 * may differ by this much in centre or radius and still be the same circle.
 * Scaling with the radius keeps the check relative on a large circle, where a
 * fixed 1e-7 would be tighter than the geometry the kernel actually hands over.
 */
function circleTolerance(radius: number): number {
  return Math.max(OCC_CONFUSION, OCC_CONFUSION * Math.abs(radius))
}

/** A part edge's index from its ancestry query, or -1 when the query names no
 *  render edge (an unnamed or stale pick). */
function edgeIndexOf(part: PartResult, query: string): number {
  const index = query ? (part.edge_queries?.indexOf(query) ?? -1) : -1
  return index >= 0 && index < (part.edges?.length ?? 0) ? index : -1
}

/** The first face whose boundary walk contains the edge query, or -1. */
function faceOfEdge(part: PartResult, query: string): number {
  const walks = part.mesh?.face_edge_queries
  if (!walks || !query) return -1
  return walks.findIndex((queries) => queries.includes(query))
}

interface CircleEdge {
  center: Vec3
  axis: Vec3
  radius: number
}

/** The analytic circle an edge states, or null for any other curve kind. */
function circleEdgeOf(edge: EdgeData): CircleEdge | null {
  if (edge.kind !== 'circle' && edge.kind !== 'arc') return null
  const axis = normalize(edge.axis)
  if (!axis) return null
  return { center: [...edge.center] as Vec3, axis, radius: edge.radius }
}

function sameCircle(a: CircleEdge, b: CircleEdge): boolean {
  const tolerance = circleTolerance(a.radius)
  if (Math.abs(a.radius - b.radius) > tolerance) return false
  if (Math.hypot(
    a.center[0] - b.center[0],
    a.center[1] - b.center[1],
    a.center[2] - b.center[2],
  ) > tolerance) return false
  // Directions are unit, so the angle is the chord between them; scaling the
  // linear tolerance by the radius turns it into the matching angular bound.
  const angleTolerance = tolerance / Math.max(a.radius, 1e-12)
  return Math.abs(dot(a.axis, b.axis)) >= Math.cos(angleTolerance)
}

function isFullSweep(sweep: number, radius: number): boolean {
  return sweep >= TWO_PI - circleTolerance(radius) / Math.max(radius, 1e-12)
}

/**
 * The sweep an arc edge really covers. A STEP circle is often stored as two
 * half arcs on the same face, so an edge whose sibling arcs share its circle is
 * summed with them: a hole rim then reads a diameter instead of a radius and a
 * 180 degree sweep. A lone arc keeps its own sweep.
 */
function mergedSweep(part: PartResult, index: number): number {
  const edge = part.edges?.[index]
  if (!edge) return 0
  if (edge.kind === 'circle') return TWO_PI
  if (edge.kind !== 'arc') return 0
  const own = circleEdgeOf(edge)
  if (!own) return 0
  const query = part.edge_queries?.[index] ?? ''
  const face = faceOfEdge(part, query)
  let sweep = Math.abs(edge.angle_end - edge.angle_start)
  if (face < 0) return sweep
  for (const siblingQuery of part.mesh?.face_edge_queries?.[face] ?? []) {
    const siblingIndex = edgeIndexOf(part, siblingQuery)
    if (siblingIndex < 0 || siblingIndex === index) continue
    const sibling = part.edges?.[siblingIndex]
    if (!sibling || sibling.kind !== 'arc') continue
    const other = circleEdgeOf(sibling)
    if (!other || !sameCircle(own, other)) continue
    sweep += Math.abs(sibling.angle_end - sibling.angle_start)
  }
  return sweep
}

function meshVertex(mesh: Mesh3D, index: number): Vec3 {
  if (Array.isArray(mesh.vertices)) return mesh.vertices[index] as Vec3
  return [mesh.vertices[index * 3], mesh.vertices[index * 3 + 1], mesh.vertices[index * 3 + 2]]
}

function meshTriangle(mesh: Mesh3D, index: number): [number, number, number] {
  if (Array.isArray(mesh.faces)) return mesh.faces[index]
  return [mesh.faces[index * 3], mesh.faces[index * 3 + 1], mesh.faces[index * 3 + 2]]
}

/**
 * A cylindrical face's extent along its own axis, from the face's mesh
 * vertices. The mesh keeps one vertex block per face and `triangle_to_face`
 * names the block, so no neighbouring face's vertices leak into the range.
 */
function cylinderLength(
  part: PartResult,
  faceIndex: number,
  axisPoint: Vec3,
  axis: Vec3,
): number | null {
  const mesh = part.mesh
  const map = mesh?.triangle_to_face
  if (!mesh || !map) return null
  let min = Infinity
  let max = -Infinity
  for (let triangle = 0; triangle < map.length; triangle++) {
    if (map[triangle] !== faceIndex) continue
    for (const vertex of meshTriangle(mesh, triangle)) {
      const at = dot(sub(meshVertex(mesh, vertex), axisPoint), axis)
      if (at < min) min = at
      if (at > max) max = at
    }
  }
  const length = max - min
  return Number.isFinite(length) && length > 0 ? length : null
}

/**
 * A planar face bounded by circles only: a disc (one boundary circle) or a ring
 * (concentric boundary circles). It is a round element the user picked for its
 * size, so it reads and pairs as a circle rather than as a flat face. An absent
 * area stays a plane: the classification needs the face's own measure to rule
 * out a slot, a pocket floor or any other circle-bounded planar patch.
 */
function circularFace(
  part: PartResult,
  faceIndex: number,
  face: FaceData,
): Primitive | null {
  const queries = part.mesh?.face_edge_queries?.[faceIndex]
  if (!queries?.length || face.area == null || !(face.area > 0)) return null
  const normal = normalize(face.normal)
  if (!normal) return null

  const circles: CircleEdge[] = []
  for (const query of queries) {
    const index = edgeIndexOf(part, query)
    if (index < 0) return null
    const edge = part.edges?.[index]
    const circle = edge ? circleEdgeOf(edge) : null
    // A line, spline or ellipse in the boundary keeps the face a plane.
    if (!edge || !circle) return null
    if (!isFullSweep(mergedSweep(part, index), circle.radius)) return null
    circles.push(circle)
  }

  // Two half arcs both merge to the same full circle; keep it once.
  const unique: CircleEdge[] = []
  for (const circle of circles) {
    if (!unique.some((other) => sameCircle(other, circle))) unique.push(circle)
  }
  if (!unique.every((circle) => Math.abs(dot(circle.axis, normal)) >= Math.cos(OCC_CONFUSION))) {
    return null
  }
  const outer = unique.reduce((widest, circle) => (circle.radius > widest.radius ? circle : widest))
  for (const circle of unique) {
    if (pointToAxisDistance(circle.center, outer.center, normal) > circleTolerance(circle.radius)) {
      return null
    }
  }
  const innerRadii = unique
    .filter((circle) => circle !== outer)
    .reduce((sum, circle) => sum + circle.radius * circle.radius, 0)
  const expected = Math.PI * (outer.radius * outer.radius - innerRadii)
  if (!(expected > 0)) return null
  if (Math.abs(face.area - expected) > CIRCULAR_FACE_AREA_TOLERANCE * expected) return null
  return { type: 'circle', center: outer.center, axis: normal, radius: outer.radius, sweep: TWO_PI }
}

/**
 * The kernel's name for a body-element pick: the body id plus the element's
 * index in that body's render arrays. Null when the id names no body element,
 * which is how a sketch or a datum pick stays out of a kernel request.
 */
export function partPickRef(
  id: string,
  parts: Record<string, PartResult> | undefined,
): Extract<MeasurePickRef, { kind: 'face' | 'edge' | 'vertex' }> | null {
  if (!parts) return null
  const found = findPartElement(id, parts)
  if (!found) return null
  return { bodyId: found.partId, kind: found.kind, index: found.index }
}

export function partPrimitive(id: string, parts: Record<string, PartResult> | undefined): Primitive | null {
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
        const sweep = mergedSweep(body, index)
        return {
          type: 'circle',
          center: [...edge.center] as Vec3,
          axis,
          radius: edge.radius,
          sweep: isFullSweep(sweep, edge.radius) ? TWO_PI : sweep,
        }
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
      const circular = circularFace(body, index, face)
      if (circular) return circular
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
      const origin = [...frame.origin] as Vec3
      const length = cylinderLength(body, index, origin, axis)
      return {
        type: 'cylinder',
        axisPoint: origin,
        axis,
        radius: frame.radius,
        ...(length !== null && { length }),
      }
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
