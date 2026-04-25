// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
import type { PlaneTransform, EdgeData, Sketch } from '../../types/cad'

/** Sentinel prefix for body-snap featureIds in synthetic otherSketches entries.
 *  computeDragMutation detects this to emit move_vertex (position only, no constraint). */
export const BODY_SNAP_FEAT_PREFIX = '__body__'

/** Project a 3D world point onto the sketch plane, returning 2D local coordinates.
 *  PlaneTransform.rotation stores axes as rows: [x0,x1,x2, y0,y1,y2, n0,n1,n2]. */
export function projectWorldToSketch(
  worldPoint: readonly [number, number, number],
  planeTransform: Pick<PlaneTransform, 'rotation' | 'origin'>,
): [number, number] {
  const r = planeTransform.rotation
  const o = planeTransform.origin
  const dx = worldPoint[0] - o[0]
  const dy = worldPoint[1] - o[1]
  const dz = worldPoint[2] - o[2]
  return [
    dx * r[0] + dy * r[1] + dz * r[2],
    dx * r[3] + dy * r[4] + dz * r[5],
  ]
}

/** Derive a PlaneTransform for a builtin sketch plane when no backend transform is available. */
export function builtinPlaneTransform(plane: string): PlaneTransform | null {
  const p = plane.startsWith('@') ? plane.slice(1) : plane
  if (p === 'builtin_plane_front') {
    return { rotation: [1, 0, 0,  0, 1, 0,  0, 0, 1], origin: [0, 0, 0] }
  }
  if (p === 'builtin_plane_top') {
    // Rx(-π/2): local x→world x, local y→world -z, local z→world y
    return { rotation: [1, 0, 0,  0, 0, -1,  0, 1, 0], origin: [0, 0, 0] }
  }
  if (p === 'builtin_plane_right') {
    // Ry(+π/2): local x→world -z, local y→world y, local z→world x
    return { rotation: [0, 0, -1,  0, 1, 0,  1, 0, 0], origin: [0, 0, 0] }
  }
  return null
}

/** Build a synthetic 2D Sketch from body vertices and edges projected onto a sketch plane.
 *  Vertices become PointEntity entries. Line edges become LineSegment entries.
 *  Circle/arc edges contribute only their center as a PointEntity.
 *  Splines contribute only their first and last point. */
export function buildBodySnapSketch(
  vertices: [number, number, number][] | undefined,
  edges: EdgeData[] | undefined,
  planeTransform: Pick<PlaneTransform, 'rotation' | 'origin'>,
): Sketch {
  const sketch: Sketch = {}
  let idx = 0

  if (vertices) {
    for (const v of vertices) {
      const [x, y] = projectWorldToSketch(v, planeTransform)
      sketch[`bv${idx++}`] = { x, y } as Sketch[string]
    }
  }

  if (edges) {
    for (const edge of edges) {
      if (edge.kind === 'line') {
        const start = projectWorldToSketch(edge.start, planeTransform)
        const end = projectWorldToSketch(edge.end, planeTransform)
        sketch[`be${idx++}`] = { start, end } as Sketch[string]
      } else if (edge.kind === 'circle' || edge.kind === 'arc') {
        const [cx, cy] = projectWorldToSketch(edge.center, planeTransform)
        sketch[`bec${idx++}`] = { x: cx, y: cy } as Sketch[string]
      } else if (edge.kind === 'spline' && edge.points.length > 0) {
        const [fx, fy] = projectWorldToSketch(edge.points[0], planeTransform)
        sketch[`bsp${idx++}`] = { x: fx, y: fy } as Sketch[string]
        if (edge.points.length > 1) {
          const last = edge.points[edge.points.length - 1]
          const [lx, ly] = projectWorldToSketch(last, planeTransform)
          sketch[`bsp${idx++}`] = { x: lx, y: ly } as Sketch[string]
        }
      }
    }
  }

  return sketch
}
