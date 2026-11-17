// A sketch pick (`entity:<fid>:<eid>` / `vertex:<fid>:<eid>:<sub>`) mapped to a
// world primitive.
//
// The sketch is looked up by the feature id the selection id carries, so two
// sketches that both own a seeded `c1` cannot measure each other's circle, and
// the solved sketch frame lifts the local point into world space. The old
// registry built `[x, y, 0]` from a sketch point, which was only right for a
// sketch on Front with its origin at the world origin.
import { add, scale, sub, type Vec3 } from '@/utils/vec3'
import type { Arc, Circle, Ellipse, LineSegment, PointEntity, Sketch } from '@/types/cad'
import { getEntityKind } from '@/types/cad'
import { geomPoint } from '@/utils/geometry/geometryMapping'
import { normalize, type Primitive } from '../primitives'

const TWO_PI = Math.PI * 2
const WORLD_UP: Vec3 = [0, 0, 1]

/** The solved sketch plane: local x/y axes and the sketch normal, in world. */
export interface SketchFrame {
  origin: Vec3
  x_axis: Vec3
  y_axis: Vec3
  normal: Vec3
}

export interface SketchPick {
  featureId: string
  eid: string
  sub?: string
}

interface SolvedSketch {
  solved?: Sketch
  plane?: SketchFrame
}

/** What a sketch solve result carries that measurement needs. */
function solvedSketch(featureId: string, solveResults: Record<string, unknown> | undefined): SolvedSketch | null {
  const solved = solveResults?.[featureId] as SolvedSketch | undefined
  return solved?.solved ? solved : null
}

export function sketchPrimitive(
  pick: SketchPick,
  fallbackSketch: Sketch | undefined,
  solveResults: Record<string, unknown> | undefined,
): Primitive | null {
  const solved = solvedSketch(pick.featureId, solveResults)
  // The per-feature solve result is the authority; the flat sketch is the test
  // and sketch-edit fallback, where the caller already narrowed it to one
  // sketch.
  const sketch = solved?.solved ?? fallbackSketch
  if (!sketch) return null
  const entity = sketch[pick.eid]
  if (!entity) return null

  const frame = solved?.plane
  const lift = (point: [number, number]): Vec3 =>
    frame
      ? add(frame.origin, add(scale(frame.x_axis, point[0]), scale(frame.y_axis, point[1])))
      : [point[0], point[1], 0]
  const normal = (frame ? normalize(frame.normal) : null) ?? WORLD_UP

  if (pick.sub) {
    const point = geomPoint(sketch, { entity: pick.eid, point: pick.sub })
    return point ? { type: 'point', p: lift(point) } : null
  }

  switch (getEntityKind(entity)) {
    case 'line': {
      const line = entity as LineSegment
      const p0 = lift(line.start)
      const p1 = lift(line.end)
      const dir = normalize(sub(p1, p0))
      if (!dir) return null
      return { type: 'line', p0, p1, dir, bounded: true }
    }
    case 'circle': {
      const circle = entity as Circle
      return { type: 'circle', center: lift(circle.center), axis: normal, radius: circle.radius, sweep: TWO_PI }
    }
    case 'arc': {
      // Sketch arc angles are stored in degrees (geometryMapping), unlike a body
      // edge's radians; the primitive always carries radians.
      const arc = entity as Arc
      return {
        type: 'circle',
        center: lift(arc.center),
        axis: normal,
        radius: arc.radius,
        sweep: (Math.abs(arc.angle_end - arc.angle_start) * Math.PI) / 180,
      }
    }
    case 'ellipse': {
      const ellipse = entity as Ellipse
      return { type: 'ellipse', center: lift(ellipse.center), axis: normal, a: ellipse.a, b: ellipse.b }
    }
    case 'point': {
      const point = entity as PointEntity
      return { type: 'point', p: lift([point.x, point.y]) }
    }
    case 'spline':
    case 'fit_spline':
      return { type: 'opaque', what: 'spline edge', ref: `${pick.featureId}:${pick.eid}` }
  }
}
