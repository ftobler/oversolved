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
): void {
  if (apex) return
  const origin = pt.origin
  const normal = pt.normal
  // A twist rotates the end frame about the normal by the total angle (right-
  // handed about it, the same sense the sweep turns). The axes and the profile's
  // in-plane coordinates both turn; the plane itself stays parallel at
  // `distance`.
  const angle = (twistDeg * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const xAxis = twistDeg === 0
    ? pt.x_axis
    : pt.x_axis.map((x, i) => x * cos + pt.y_axis[i] * sin)
  const yAxis = twistDeg === 0
    ? pt.y_axis
    : pt.y_axis.map((y, i) => y * cos - pt.x_axis[i] * sin)

  const boundary = surfaces.length ? ((surfaces[0].boundary as Dict[]) ?? []) : []
  const [loopU, loopV] = loopCentroid(boundary)
  const [u, v] = twistDeg === 0
    ? [loopU, loopV]
    : [loopU * cos - loopV * sin, loopU * sin + loopV * cos]

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
