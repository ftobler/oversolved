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
import { dot, sub } from '@/utils/vec3'
import { normalize, type Primitive, type Vec3 } from '../primitives'
import {
  analyticEdgePrimitive,
  boundaryCircleOf,
  circularFacePrimitive,
  sameCircle,
  surfacePrimitive,
  TWO_PI,
  type AnalyticEdge,
  type BoundaryCircle,
} from './analytic'

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

/** The part editor's edge record as the shared analytic shape. */
function analyticEdgeOf(edge: EdgeData): AnalyticEdge {
  switch (edge.kind) {
    case 'line':
      return { kind: 'line', start: edge.start, end: edge.end }
    case 'circle':
    case 'arc':
      return { kind: 'circle', center: edge.center, axis: edge.axis, radius: edge.radius }
    case 'ellipse':
      return {
        kind: 'ellipse',
        center: edge.center,
        axis: edge.axis,
        a: edge.a,
        b: edge.b,
        fullTurn: Math.abs(edge.angle_end - edge.angle_start) >= TWO_PI - 1e-9,
      }
    case 'spline':
      return { kind: 'spline' }
  }
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
  const shape = analyticEdgeOf(edge)
  const own = boundaryCircleOf(shape, 0)
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
    const other = boundaryCircleOf(analyticEdgeOf(sibling), 0)
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
 * (concentric boundary circles). The boundary walk itself is the part adapter's
 * (queries -> edge records); the classification is the shared one.
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

  const rings: BoundaryCircle[] = []
  for (const query of queries) {
    const index = edgeIndexOf(part, query)
    if (index < 0) return null
    const edge = part.edges?.[index]
    // A line, spline or ellipse in the boundary keeps the face a plane.
    if (!edge) return null
    const ring = boundaryCircleOf(analyticEdgeOf(edge), mergedSweep(part, index))
    if (!ring) return null
    rings.push(ring)
  }
  return circularFacePrimitive(rings, face.area, normal)
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
    return analyticEdgePrimitive(analyticEdgeOf(edge), mergedSweep(body, index), id)
  }

  const face = body.mesh?.face_data?.[index]
  if (!face) return null
  // The round-flat-face check only means something for a flat face, and the
  // axial length only for a cylinder: classifying every face would scan a
  // curved face's triangles for a number its primitive discards.
  const flat = face.surface_type === undefined || face.surface_type === 'flatface'
  const circular = flat ? circularFace(body, index, face) : null
  const frame = face.surface_frame
  const axis = frame ? normalize(frame.axis) : null
  const length = face.surface_type === 'cylinderface' && frame && axis
    ? cylinderLength(body, index, [...frame.origin] as Vec3, axis)
    : null
  return surfacePrimitive(
    {
      surfaceType: face.surface_type,
      centroid: face.centroid,
      normal: face.normal,
      frame: frame
        ? {
            origin: frame.origin,
            axis: frame.axis,
            radius: frame.radius,
            semiAngle: frame.semi_angle,
            minorRadius: frame.minor_radius,
          }
        : null,
    },
    circular,
    length,
    id,
  )
}
