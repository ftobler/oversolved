// Tessellate a topology surface boundary (the area builder's output) into a flat
// 2D polygon point list. Shared by every boundary consumer -- the 3D fill shape,
// the picking ID shape, and anything else that needs a closed polygon -- so that
// line, arc, spline (cubic Bezier) and full-ellipse edges are all handled in one
// place. The 2D SVG fill path is built separately (it emits real curve commands).

import type {
  TopologyEdge,
  TopologyArcEdge,
  TopologySplineEdge,
  TopologyEllipseEdge,
  TopologyEllipseArcEdge,
  Point,
} from '@/types/cad'

const DEFAULT_SEGMENTS = 64
const TWO_PI = 2 * Math.PI

/** Interior + end points of a cubic-Bezier spline edge (the caller pushes start). */
function splinePts(edge: TopologySplineEdge, segments: number): Point[] {
  const [p1, c1, c2, p4] = [edge.start, edge.c1, edge.c2, edge.end]
  const out: Point[] = []
  for (let i = 1; i <= segments; i++) {
    const t = i / segments
    const mt = 1 - t
    const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t
    out.push([
      a * p1[0] + b * c1[0] + c * c2[0] + d * p4[0],
      a * p1[1] + b * c1[1] + c * c2[1] + d * p4[1],
    ])
  }
  return out
}

/** A closed-polygon tessellation of a full ellipse edge (its own self-closed loop). */
function ellipsePts(edge: TopologyEllipseEdge, segments: number): Point[] {
  const [cx, cy] = edge.center
  const rot = (edge.theta ?? 0) * (Math.PI / 180)
  const cr = Math.cos(rot), sr = Math.sin(rot)
  const out: Point[] = []
  for (let i = 0; i < segments; i++) {
    const t = (2 * Math.PI * i) / segments
    const ax = edge.a * Math.cos(t), ay = edge.b * Math.sin(t)
    out.push([cx + ax * cr - ay * sr, cy + ax * sr + ay * cr])
  }
  return out
}

/** Interior + end points of an elliptical-arc edge (the caller pushes start). */
function ellipseArcPts(edge: TopologyEllipseArcEdge, segments: number): Point[] {
  const [cx, cy] = edge.center
  const rot = (edge.theta ?? 0) * (Math.PI / 180)
  const cr = Math.cos(rot), sr = Math.sin(rot)
  const p0 = (edge.angle_start_deg * Math.PI) / 180
  let p1 = (edge.angle_end_deg * Math.PI) / 180
  if (edge.ccw) { if (p1 < p0) p1 += TWO_PI } else if (p1 > p0) p1 -= TWO_PI
  const steps = Math.max(2, Math.ceil((Math.abs(p1 - p0) / TWO_PI) * segments))
  const out: Point[] = []
  for (let i = 1; i <= steps; i++) {
    const phi = p0 + ((p1 - p0) * i) / steps
    const ax = edge.a * Math.cos(phi), ay = edge.b * Math.sin(phi)
    out.push([cx + ax * cr - ay * sr, cy + ax * sr + ay * cr])
  }
  return out
}

/** Interior + end points of an arc edge (the caller pushes start). */
function arcPts(edge: TopologyArcEdge, segments: number): Point[] {
  const { center, radius, angle_start_deg, angle_end_deg, ccw } = edge
  const span = ccw
    ? ((angle_end_deg - angle_start_deg) + 360) % 360
    : -(((angle_start_deg - angle_end_deg) + 360) % 360)
  const steps = Math.max(2, Math.ceil((Math.abs(span) / 360) * segments))
  const out: Point[] = []
  for (let i = 1; i <= steps; i++) {
    const a = (angle_start_deg + (span * i) / steps) * (Math.PI / 180)
    out.push([center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)])
  }
  return out
}

/**
 * Tessellate a boundary loop into a closed 2D polygon. A full ellipse is a
 * standalone closed loop (no shared endpoints); every other edge contributes its
 * start once (first edge only) plus the points along it to its end.
 */
export function tessellateBoundary(boundary: TopologyEdge[], segments = DEFAULT_SEGMENTS): Point[] {
  const pts: Point[] = []
  boundary.forEach((edge, ei) => {
    if (edge.kind === 'ellipse') {
      pts.push(...ellipsePts(edge, segments))
      return
    }
    if (ei === 0) pts.push(edge.start)
    if (edge.kind === 'line') {
      pts.push(edge.end)
    } else if (edge.kind === 'spline') {
      pts.push(...splinePts(edge, segments))
    } else if (edge.kind === 'ellipse_arc') {
      pts.push(...ellipseArcPts(edge, segments))
    } else {
      pts.push(...arcPts(edge, segments))
    }
  })
  return pts
}
