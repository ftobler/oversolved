import * as THREE from 'three'
import type { Topology, TopologySurface } from '@/types/cad'
import { tessellateBoundary } from '@/kernel/topologyBoundary'
import { ARC_SEGMENTS } from './arcSegments'

/**
 * The one area-shape builder. Both consumers of a sketch area -- the visible
 * fill (Surfaces.tsx) and the pick triangles (useSketchSurfaceIdRegistration)
 * -- build their geometry from this function, so the pixels the user clicks are
 * the pixels they see. They used to call tessellateBoundary with 64 and 32
 * segments respectively, and each claimed to reproduce the other's positions;
 * the pick outline drifted off the drawn fill along every arc edge.
 *
 * Pure geometry in the utils leaf: the picking layer must not import the UI
 * tree (importBoundary.test.ts).
 */

// The segment count both paths share, aliased to the scene's one arc
// tessellation. Exported so a test can pin that both paths agree on it.
export const SURFACE_TESSELLATION_SEGMENTS = ARC_SEGMENTS

export interface SurfaceShape {
  shape: THREE.Shape
  // Outer ring in sketch-plane coordinates, in draw order. The pick path
  // reuses this as the probe's coverage polygon.
  pts: [number, number][]
  query: string
  buildable: boolean
}

export function buildSurfaceShapes(topology: Topology): SurfaceShape[] {
  return topology.surfaces.flatMap((surface: TopologySurface) => {
    const pts = tessellateBoundary(surface.boundary, SURFACE_TESSELLATION_SEGMENTS)
    if (pts.length < 3) return []
    const shape = new THREE.Shape()
    shape.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1])
    shape.closePath()
    // Inner loops become THREE.Path holes so a donut renders with its hole and
    // is not pickable as solid material in the middle.
    for (const hole of surface.holes ?? []) {
      const hpts = tessellateBoundary(hole, SURFACE_TESSELLATION_SEGMENTS)
      if (hpts.length < 3) continue
      const path = new THREE.Path()
      path.moveTo(hpts[0][0], hpts[0][1])
      for (let i = 1; i < hpts.length; i++) path.lineTo(hpts[i][0], hpts[i][1])
      path.closePath()
      shape.holes.push(path)
    }
    // Absent stamp = an older/hand-built topology that never ran the gate;
    // treat it as buildable so nothing pre-existing suddenly reads as broken.
    return [{ shape, pts, query: surface.query, buildable: surface.buildable !== false }]
  })
}
