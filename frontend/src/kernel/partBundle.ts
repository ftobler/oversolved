// A PartBundle is a rev-keyed, derivable artifact built from a PartDoc by a
// transient OCC worker (the bundle builder). It carries everything an assembly
// solver needs — meshes, edge curves, and an anchor dict — so the assembly
// worker never touches OCC or runs solveLocally. The bundle is cached in
// IndexedDb keyed by (doc_id, doc_rev); a miss triggers a cold rebuild.

import type { EdgeData, BodyResult } from '../types/cad'

export type AnchorKind = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'line' | 'circle' | 'point'

export interface Anchor {
  kind: AnchorKind
  point: [number, number, number]
  axis: [number, number, number]
  geom_hash: string
  created_by: string
}

export interface EdgeCurve {
  id: string
  kind: 'line' | 'circle' | 'ellipse' | 'b-spline'
  point: [number, number, number]
  axis?: [number, number, number]
  radius?: number
  endpoints: [[number, number, number], [number, number, number]]
}

export interface BodyMesh {
  mesh: {
    vertices: Float32Array
    indices: Uint32Array
    faceIdsPerTriangle: Uint32Array
  }
  edges: EdgeCurve[]
}

export interface PartBundle {
  doc_id: string
  doc_rev: number
  bodies: BodyMesh[]
  anchors: Record<string, Anchor>
}

// ── Conversion from BuildResponse output ──────────────────────────────────

type Vec3 = [number, number, number]

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
  if (len < 1e-15) return [0, 0, 0]
  return [v[0] / len, v[1] / len, v[2] / len]
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5]
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/** Point on a circle at parametric angle, given center, radius, x_axis, and the circle's normal axis. */
function circlePoint(
  center: Vec3, radius: number, axis: Vec3, xAxis: Vec3, angle: number,
): Vec3 {
  const yAxis = normalize(cross(axis, xAxis))
  const ux = normalize(xAxis)
  return [
    center[0] + radius * Math.cos(angle) * ux[0] + radius * Math.sin(angle) * yAxis[0],
    center[1] + radius * Math.cos(angle) * ux[1] + radius * Math.sin(angle) * yAxis[1],
    center[2] + radius * Math.cos(angle) * ux[2] + radius * Math.sin(angle) * yAxis[2],
  ]
}

/** Point on an ellipse at parametric eccentric angle. */
function ellipsePoint(
  center: Vec3, a: number, b: number, axis: Vec3, xAxis: Vec3, angle: number,
): Vec3 {
  const yAxis = normalize(cross(axis, xAxis))
  const ux = normalize(xAxis)
  return [
    center[0] + a * Math.cos(angle) * ux[0] + b * Math.sin(angle) * yAxis[0],
    center[1] + a * Math.cos(angle) * ux[1] + b * Math.sin(angle) * yAxis[1],
    center[2] + a * Math.cos(angle) * ux[2] + b * Math.sin(angle) * yAxis[2],
  ]
}

/** Convert a single EdgeData to an EdgeCurve for the assembly bundle. */
export function toEdgeCurve(ed: EdgeData, edgeQuery: string): EdgeCurve {
  const id = edgeQuery
  switch (ed.kind) {
    case 'line': {
      const dir = sub(ed.end, ed.start)
      return {
        id, kind: 'line',
        point: midpoint(ed.start, ed.end),
        axis: normalize(dir) as Vec3,
        endpoints: [ed.start, ed.end],
      }
    }
    case 'circle':
    case 'arc': {
      const startPt = circlePoint(ed.center, ed.radius, ed.axis, ed.x_axis, ed.angle_start)
      const endPt = circlePoint(ed.center, ed.radius, ed.axis, ed.x_axis, ed.angle_end)
      return {
        id, kind: 'circle',
        point: ed.center,
        axis: ed.axis,
        radius: ed.radius,
        endpoints: [startPt, endPt],
      }
    }
    case 'ellipse': {
      const startPt = ellipsePoint(ed.center, ed.a, ed.b, ed.axis, ed.x_axis, ed.angle_start)
      const endPt = ellipsePoint(ed.center, ed.a, ed.b, ed.axis, ed.x_axis, ed.angle_end)
      return {
        id, kind: 'ellipse',
        point: ed.center,
        axis: ed.axis,
        radius: ed.a,
        endpoints: [startPt, endPt],
      }
    }
    case 'spline': {
      const pts = ed.points
      const midIdx = Math.floor(pts.length / 2)
      return {
        id, kind: 'b-spline',
        point: pts[midIdx],
        endpoints: [pts[0], pts[pts.length - 1]],
      }
    }
  }
}

function flattenVerts(verts: [number, number, number][]): Float32Array {
  const out = new Float32Array(verts.length * 3)
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i]
    out[i * 3] = v[0]; out[i * 3 + 1] = v[1]; out[i * 3 + 2] = v[2]
  }
  return out
}

function flattenFaces(faces: [number, number, number][]): Uint32Array {
  const out = new Uint32Array(faces.length * 3)
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i]
    out[i * 3] = f[0]; out[i * 3 + 1] = f[1]; out[i * 3 + 2] = f[2]
  }
  return out
}

function toUint32(arr: number[]): Uint32Array {
  const out = new Uint32Array(arr.length)
  for (let i = 0; i < arr.length; i++) out[i] = arr[i]
  return out
}

/** Convert a single BodyResult (raw from tessellation) to a BodyMesh for the bundle. */
export function toBodyMesh(bodyResult: BodyResult): BodyMesh {
  const mesh = bodyResult.mesh
  const edges: EdgeCurve[] = []
  if (bodyResult.edges && bodyResult.edge_queries) {
    for (let i = 0; i < bodyResult.edges.length; i++) {
      edges.push(toEdgeCurve(bodyResult.edges[i], bodyResult.edge_queries[i]))
    }
  }
  if (!mesh) {
    return {
      mesh: {
        vertices: new Float32Array(0),
        indices: new Uint32Array(0),
        faceIdsPerTriangle: new Uint32Array(0),
      },
      edges,
    }
  }
  const vertices = mesh.vertices instanceof Float32Array
    ? mesh.vertices
    : flattenVerts(mesh.vertices as [number, number, number][])
  const facesRaw = mesh.faces as Uint32Array | [number, number, number][]
  const indices = facesRaw instanceof Uint32Array
    ? facesRaw
    : flattenFaces(facesRaw)
  const triCount = indices.length / 3
  const faceIdsPerTriangle = mesh.triangle_to_face
    ? toUint32(mesh.triangle_to_face)
    : new Uint32Array(triCount)
  return {
    mesh: { vertices, indices, faceIdsPerTriangle },
    edges,
  }
}

/** Build a PartBundle from the raw solve output (tuples still in place from tessellation). */
export function toPartBundle(
  doc_id: string,
  doc_rev: number,
  bodyResults: Record<string, BodyResult>,
): PartBundle {
  const bodies: BodyMesh[] = []
  for (const body of Object.values(bodyResults)) {
    bodies.push(toBodyMesh(body))
  }
  return { doc_id, doc_rev, bodies, anchors: {} }
}
