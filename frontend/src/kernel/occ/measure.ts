/**
 * The one measure record for a solved body set. It lives in an OCC leaf module
 * (no solve imports) so `solveLocally`, the oracle runner and the translations
 * tier share one record without a cycle.
 *
 * The bbox is `BRepBndLib.AddOptimal`, the read an external tool reports:
 * `BRepBndLib.Add` enlarges the box by each sub-shape's tolerance and boxes a
 * B-spline's control net, both of which make it useless as a comparison value.
 * `measureLocallyReal.test.ts` pins the difference on a B-spline sweep.
 */

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape } from './occTypes'
import type { Vec3 } from './primitives'
import { canonicalEdges, canonicalFaces, canonicalVertices } from './bodyNames'
import { surfaceAreaOf, volumeAndCentroidOf } from './volume'

/** [xmin, ymin, zmin, xmax, ymax, zmax], the order a reference file writes. */
export type Bbox6 = [number, number, number, number, number, number]

export interface MeasureRecord {
  bodies: number
  // Summed over the closed bodies (OnlyClosed = true).
  volume: number
  // Summed over every body, open shells included.
  area: number
  // Volume-weighted; the plain body average when no body has volume (an open
  // shell only set); null iff bodies === 0.
  centroid: Vec3 | null
  bbox: Bbox6 | null
  faces: number
  edges: number
  vertices: number
}

/**
 * Measure one shape in full. The volume pass also yields the centroid, so the
 * record costs one BRepGProp pass per integral rather than the old extra
 * centroid pass.
 */
export function measureShape(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
): Omit<MeasureRecord, 'bodies'> {
  const { volume, centroid } = volumeAndCentroidOf(oc, scope, shape)
  const area = surfaceAreaOf(oc, scope, shape)

  const box = scope.track(new oc.Bnd_Box_1())
  oc.BRepBndLib.AddOptimal(shape, box, false, false)
  const bbox: Bbox6 = [
    box.GetXmin(), box.GetYmin(), box.GetZmin(),
    box.GetXmax(), box.GetYmax(), box.GetZmax(),
  ]

  return {
    volume,
    area,
    centroid,
    bbox,
    faces: canonicalFaces(oc, scope, shape).length,
    edges: canonicalEdges(oc, scope, shape).length,
    vertices: canonicalVertices(oc, scope, shape).length,
  }
}

/** Aggregate a body set: sums, a volume-weighted centroid, a bbox union. */
export function measureBodies(oc: OccModule, scope: DisposeScope, shapes: readonly OccShape[]): MeasureRecord {
  let volume = 0
  let area = 0
  let faces = 0
  let edges = 0
  let vertices = 0
  let bbox: Bbox6 | null = null
  const weighted: Vec3 = [0, 0, 0]
  const centroidSum: Vec3 = [0, 0, 0]

  for (const shape of shapes) {
    const body = measureShape(oc, scope, shape)
    volume += body.volume
    area += body.area
    faces += body.faces
    edges += body.edges
    vertices += body.vertices
    for (let axis = 0; axis < 3; axis++) {
      weighted[axis] += body.centroid![axis] * body.volume
      centroidSum[axis] += body.centroid![axis]
    }
    if (bbox === null) {
      bbox = [...body.bbox!] as Bbox6
    } else {
      for (let axis = 0; axis < 3; axis++) {
        bbox[axis] = Math.min(bbox[axis], body.bbox![axis])
        bbox[axis + 3] = Math.max(bbox[axis + 3], body.bbox![axis + 3])
      }
    }
  }

  const bodies = shapes.length
  // An open shell integrates to zero volume, so there is no mass to weight by:
  // fall back to the plain body average instead of dividing by ~0.
  const centroid: Vec3 | null = bodies === 0
    ? null
    : Math.abs(volume) > 1e-12
      ? [weighted[0] / volume, weighted[1] / volume, weighted[2] / volume]
      : [centroidSum[0] / bodies, centroidSum[1] / bodies, centroidSum[2] / bodies]

  return { bodies, volume, area, centroid, bbox, faces, edges, vertices }
}
