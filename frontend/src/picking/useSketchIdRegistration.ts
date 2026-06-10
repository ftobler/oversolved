import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useIdPipeline } from './IdPipelineContext'
import type { Sketch, PlaneTransform, LineSegment, Circle, Arc, PointEntity, Ellipse, Spline } from '@/types/cad'
import { getEntityKind } from '@/types/cad'
import { sampleArcCCW, sampleEllipse, sampleBezier, ellipseAxisPoints, ELLIPSE_AXIS_KEYS } from '@/components/sketch/sketch_helpers'

/**
 * Register a sketch's entities and vertices with the sketchEntity and
 * sketchVertex ID layers.
 *
 * Sketch entities are 2D in the sketch plane; the hook applies the plane
 * transform (rotation + origin) so the registered segments and vertex
 * centers sit at the same world positions as the visible
 * EntityLines/VertexDots geometry. The layer's shader then handles
 * screen-space fattening as usual.
 *
 * Composite-ID format matches the live store:
 *   entity composite:  `entity:${featureId}:${entityId}`
 *   vertex composite:  `vertex:${featureId}:${entityId}:${vertexKey}`
 * (See VertexDots.tsx:124 and EntityLines.tsx:21.)
 *
 * Inactive features (those not being edited) are still registered, so a
 * user can pick across other visible sketches. Suppressing those is a
 * caller decision via `enabled`.
 */

function buildPlaneMatrix(planeTransform?: PlaneTransform): THREE.Matrix4 {
  const m = new THREE.Matrix4()
  if (!planeTransform) return m
  const [x0, x1, x2, y0, y1, y2, n0, n1, n2] = planeTransform.rotation
  // Same transposed layout as planeRotationFromTransform in Geometry3D/utils.ts.
  m.set(
    x0, y0, n0, 0,
    x1, y1, n1, 0,
    x2, y2, n2, 0,
    0,  0,  0,  1,
  )
  const o = planeTransform.origin
  m.setPosition(o[0] ?? 0, o[1] ?? 0, o[2] ?? 0)
  return m
}

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

interface Segments {
  segmentPositions: Float32Array
  segmentToEdge: Uint32Array
  edgeQueries: string[]
}

interface Vertices {
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
): Vertices {
  const vertices: [number, number, number][] = []
  const vertexQueries: string[] = []
  const v = new THREE.Vector3()
  const push = (entityId: string, key: string, x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    v.set(x, y, 0).applyMatrix4(planeMatrix)
    vertices.push([v.x, v.y, v.z])
    vertexQueries.push(`vertex:${featureId}:${entityId}:${key}`)
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

export function useSketchIdRegistration(params: {
  featureId: string
  sketch: Sketch | undefined
  planeTransform?: PlaneTransform
  enabled?: boolean
}): void {
  const pipeline = useIdPipeline()
  const { featureId, sketch, planeTransform, enabled = true } = params

  // Build a stable matrix key from planeTransform so the hook re-runs when
  // the plane changes but not just because the prop reference shifts.
  const planeKey = useMemo(() => {
    if (!planeTransform) return 'identity'
    return planeTransform.rotation.join(',') + '|' + planeTransform.origin.join(',')
  }, [planeTransform])

  useEffect(() => {
    if (!enabled) return
    if (!pipeline) return
    if (!sketch || Object.keys(sketch).length === 0) return

    const m = buildPlaneMatrix(planeTransform)
    const seg = buildSketchSegments(featureId, sketch, m)
    const vtx = buildSketchVertices(featureId, sketch, m)

    if (seg.edgeQueries.length > 0) {
      pipeline.sketchEntityLayer.registerBody({
        bodyKey: featureId,
        segmentPositions: seg.segmentPositions,
        segmentToEdge: seg.segmentToEdge,
        edgeQueries: seg.edgeQueries,
      })
    }
    if (vtx.vertices.length > 0) {
      pipeline.sketchVertexLayer.registerBody({
        bodyKey: featureId,
        vertices: vtx.vertices,
        vertexQueries: vtx.vertexQueries,
      })
    }
    pipeline.markDirty()

    return () => {
      pipeline.sketchEntityLayer.unregisterBody(featureId)
      pipeline.sketchVertexLayer.unregisterBody(featureId)
      pipeline.markDirty()
    }
    // planeKey is the load-bearing dep for plane changes; planeTransform
    // object identity isn't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline, featureId, sketch, planeKey, enabled])
}
