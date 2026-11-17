// Register the swept top face (and its first edge) of an extrude so later
// sketches/queries can reference them (mirrors `_register_top_face`).

import { loopCentroid } from '../../profileLoops'
import type { Repository } from '../../query'
import type { PlaneLike } from './planes'

type Dict = Record<string, unknown>

/**
 * Register the swept top face (and its first edge) of an extrude so later
 * sketches/queries can reference them (mirrors `_register_top_face`). The top
 * centroid is the area-weighted loop centroid lifted to the sketch plane and
 * pushed by `distance` along the normal.
 *
 * A tapered end's rim is the offset boundary, not the authored one, so there is
 * no un-offset `edge0` to register there: the face/plane is still the honest
 * top, but the synthetic edge is skipped rather than naming an edge that does
 * not exist on the body. A twisted end's rim is the rotated boundary, so its
 * `edge0` is skipped for the same reason; the plane's axes and the centroid are
 * rotated to the end frame the body actually ends on.
 *
 * `reverse` is the sweep's direction: a reverse extrude travels along
 * `-normal`, so its twist turns the other way about the registered normal. (The
 * registered plane's POSITION is still `origin + normal * distance` for both
 * directions, which is the pre-existing reverse defect in `feature/backlog.md`,
 * out of scope here.)
 *
 * An apex end has no top face at all (the profile closed to a point), so `apex`
 * skips the face too: a registered plane at `distance` would be a phantom a
 * sketch could sit on.
 */
export function registerTopFace(
  globalRepo: Repository,
  featureId: string,
  pt: PlaneLike,
  surfaces: Dict[],
  distance: number,
  taperDeg = 0,
  apex = false,
  twistDeg = 0,
  reverse = false,
): void {
  if (apex) return
  const origin = pt.origin
  const normal = pt.normal
  // A twist rotates the end frame about the sweep's travel direction by the
  // total angle. The frame's axes turn and the profile's own coordinates stay,
  // so the centroid lands where the rotated axes carry it; the plane itself
  // stays parallel at `distance`. A reverse sweep travels along `-normal`, so
  // the same authored twist turns the opposite way about the registered normal.
  const angle = ((reverse ? -twistDeg : twistDeg) * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const xAxis = twistDeg === 0
    ? pt.x_axis
    : pt.x_axis.map((x, i) => x * cos + pt.y_axis[i] * sin)
  const yAxis = twistDeg === 0
    ? pt.y_axis
    : pt.y_axis.map((y, i) => y * cos - pt.x_axis[i] * sin)

  const boundary = surfaces.length ? ((surfaces[0].boundary as Dict[]) ?? []) : []
  // The profile's in-plane coordinates are unchanged in the end frame: the
  // frame's own axes turned with the geometry, so `u, v` still name the same
  // material point and the rotated axes carry it around the sketch origin.
  const [u, v] = loopCentroid(boundary)

  const sketchCentroid = [
    origin[0] + u * xAxis[0] + v * yAxis[0],
    origin[1] + u * xAxis[1] + v * yAxis[1],
    origin[2] + u * xAxis[2] + v * yAxis[2],
  ]
  const topCentroid = [
    sketchCentroid[0] + normal[0] * distance,
    sketchCentroid[1] + normal[1] * distance,
    sketchCentroid[2] + normal[2] * distance,
  ]
  const topPlaneOrigin = [
    origin[0] + normal[0] * distance,
    origin[1] + normal[1] * distance,
    origin[2] + normal[2] * distance,
  ]

  globalRepo.register(featureId + '/top_face', {
    type: 'flatface',
    centroid: topCentroid,
    normal: [...normal],
    origin: topPlaneOrigin,
    x_axis: [...xAxis],
    y_axis: [...yAxis],
  })

  if (taperDeg === 0 && twistDeg === 0 && surfaces.length && (surfaces[0].boundary as Dict[])?.length) {
    const edge = (surfaces[0].boundary as Dict[])[0]
    if ('start' in edge && 'end' in edge) {
      const s2d = edge.start as number[]
      const e2d = edge.end as number[]
      const s3d = [
        origin[0] + s2d[0] * xAxis[0] + s2d[1] * yAxis[0] + normal[0] * distance,
        origin[1] + s2d[0] * xAxis[1] + s2d[1] * yAxis[1] + normal[1] * distance,
        origin[2] + s2d[0] * xAxis[2] + s2d[1] * yAxis[2] + normal[2] * distance,
      ]
      const e3d = [
        origin[0] + e2d[0] * xAxis[0] + e2d[1] * yAxis[0] + normal[0] * distance,
        origin[1] + e2d[0] * xAxis[1] + e2d[1] * yAxis[1] + normal[1] * distance,
        origin[2] + e2d[0] * xAxis[2] + e2d[1] * yAxis[2] + normal[2] * distance,
      ]
      globalRepo.register(featureId + '/top_face/edge0', {
        type: 'straightedge',
        start: s3d,
        end: e3d,
      })
    }
  }
}
