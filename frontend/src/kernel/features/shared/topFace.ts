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
 */
export function registerTopFace(
  globalRepo: Repository,
  featureId: string,
  pt: PlaneLike,
  surfaces: Dict[],
  distance: number,
): void {
  const origin = pt.origin
  const xAxis = pt.x_axis
  const yAxis = pt.y_axis
  const normal = pt.normal

  const boundary = surfaces.length ? ((surfaces[0].boundary as Dict[]) ?? []) : []
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

  if (surfaces.length && (surfaces[0].boundary as Dict[])?.length) {
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
