import * as THREE from 'three'
import type { Sketch, LineSegment, Circle, Arc, PointEntity, Ellipse, Spline } from '@/types/cad'
import { getEntityKind } from '@/types/cad'
import { sampleArcCCW, sampleEllipse, sampleBezier, ellipseAxisPoints, ELLIPSE_AXIS_KEYS } from '@/components/sketch/sketch_helpers'

// Pure builders that turn a sketch + plane matrix into the segment/vertex
// buffers the sketchEntity / sketchVertex ID layers consume. Lives outside the
// hook so it can be unit-tested without React and reused by callers that do not
// want the registration side effects.

function appendSegment(
  out: number[],
  m: THREE.Matrix4,
  v: THREE.Vector3,
  ax: number, ay: number,
  bx: number, by: number,
): void {
  v.set(ax, ay, 0).applyMatrix4(m)
  out.push(v.x, v.y, v.z)
  v.set(bx, by, 0).applyMatrix4(m)
  out.push(v.x, v.y, v.z)
}

export interface Segments {
  segmentPositions: Float32Array
  segmentToEdge: Uint32Array
  edgeQueries: string[]
}

export interface Vertices {
  vertices: [number, number, number][]
  vertexQueries: string[]
}

export function buildSketchSegments(
  featureId: string,
  sketch: Sketch,
  planeMatrix: THREE.Matrix4,
): Segments {
  const positions: number[] = []
  const segmentToEdge: number[] = []
  const edgeQueries: string[] = []
  const v = new THREE.Vector3()

  for (const [entityId, entity] of Object.entries(sketch)) {
    const kind = getEntityKind(entity)
    const before = positions.length
    if (kind === 'line') {
      const l = entity as LineSegment
      appendSegment(positions, planeMatrix, v, l.start[0], l.start[1], l.end[0], l.end[1])
    } else if (kind === 'arc') {
      const a = entity as Arc
      const pts = sampleArcCCW(a.center[0], a.center[1], a.radius, a.angle_start, a.angle_end)
      for (let i = 0; i < pts.length - 1; i++) {
        appendSegment(positions, planeMatrix, v, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])
      }
    } else if (kind === 'circle') {
      const c = entity as Circle
      const pts = sampleArcCCW(c.center[0], c.center[1], c.radius, 0, 360)
      for (let i = 0; i < pts.length - 1; i++) {
        appendSegment(positions, planeMatrix, v, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])
      }
    } else if (kind === 'ellipse') {
      const el = entity as Ellipse
      const pts = sampleEllipse(el.center[0], el.center[1], el.a, el.b, el.theta)
      for (let i = 0; i < pts.length - 1; i++) {
        appendSegment(positions, planeMatrix, v, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])
      }
    } else if (kind === 'spline') {
      const sp = entity as Spline
      const pts = sampleBezier(sp.p1, sp.p2, sp.p3, sp.p4)
      for (let i = 0; i < pts.length - 1; i++) {
        appendSegment(positions, planeMatrix, v, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])
      }
    } else {
      // point entities have no segments; they show only via the vertex layer.
      continue
    }
    const newSegments = (positions.length - before) / 6
    if (newSegments === 0) continue
    const edgeIdx = edgeQueries.length
    edgeQueries.push(`entity:${featureId}:${entityId}`)
    for (let i = 0; i < newSegments; i++) segmentToEdge.push(edgeIdx)
  }

  return {
    segmentPositions: new Float32Array(positions),
    segmentToEdge: new Uint32Array(segmentToEdge),
    edgeQueries,
  }
}

export function buildSketchVertices(
  featureId: string,
  sketch: Sketch,
  planeMatrix: THREE.Matrix4,
  suppressed?: Set<string>,
): Vertices {
  const vertices: [number, number, number][] = []
  const vertexQueries: string[] = []
  const v = new THREE.Vector3()
  const push = (entityId: string, key: string, x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    const query = `vertex:${featureId}:${entityId}:${key}`
    // A coincident partner is not pickable: its cluster leader is registered at
    // the same spot, so hover/select resolves to the same handle the render
    // layer draws (VertexDot suppresses the identical id).
    if (suppressed?.has(query)) return
    v.set(x, y, 0).applyMatrix4(planeMatrix)
    vertices.push([v.x, v.y, v.z])
    vertexQueries.push(query)
  }

  for (const [entityId, entity] of Object.entries(sketch)) {
    const kind = getEntityKind(entity)
    if (kind === 'line') {
      const l = entity as LineSegment
      push(entityId, 'start', l.start[0], l.start[1])
      push(entityId, 'end',   l.end[0],   l.end[1])
    } else if (kind === 'arc') {
      const a = entity as Arc
      push(entityId, 'start',  a.start[0],  a.start[1])
      push(entityId, 'end',    a.end[0],    a.end[1])
      push(entityId, 'center', a.center[0], a.center[1])
    } else if (kind === 'circle') {
      const c = entity as Circle
      push(entityId, 'center', c.center[0], c.center[1])
    } else if (kind === 'ellipse') {
      const el = entity as Ellipse
      push(entityId, 'center', el.center[0], el.center[1])
      const ap = ellipseAxisPoints(el.center[0], el.center[1], el.a, el.b, el.theta)
      for (const key of ELLIPSE_AXIS_KEYS) push(entityId, key, ap[key][0], ap[key][1])
    } else if (kind === 'spline') {
      const sp = entity as Spline
      push(entityId, 'start', sp.p1[0], sp.p1[1])
      push(entityId, 'c1',    sp.p2[0], sp.p2[1])
      push(entityId, 'c2',    sp.p3[0], sp.p3[1])
      push(entityId, 'end',   sp.p4[0], sp.p4[1])
    } else if (kind === 'point') {
      const p = entity as PointEntity
      push(entityId, 'xy', p.x, p.y)
    }
  }

  return { vertices, vertexQueries }
}