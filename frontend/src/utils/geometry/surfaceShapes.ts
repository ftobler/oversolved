import type { Topology, TopologySurface } from '@/types/cad'
import { tessellateBoundary } from '@/kernel/topologyBoundary'
import { ARC_SEGMENTS } from './arcSegments'

/**
 * The one area-outline builder. Both consumers of a sketch area -- the visible
 * fill (`components/Geometry3D/Surfaces.tsx`) and the pick triangles
 * (`useSketchSurfaceIdRegistration`) -- read their boundary from this function,
 * so the pixels the user clicks are the pixels they see. They used to call
 * tessellateBoundary with 64 and 32 segments respectively, and each claimed to
 * reproduce the other's positions; the pick outline drifted off the drawn fill
 * along every arc edge.
 *
 * Pure geometry in the utils leaf: the picking layer must not import the UI
 * tree (importBoundary.test.ts). The THREE.Shape wrapper is the component-side
 * `components/Geometry3D/surfaceShapes.ts`.
 */

// The segment count both paths share, aliased to the scene's one arc
// tessellation. Exported so a test can pin that both paths agree on it.
export const SURFACE_TESSELLATION_SEGMENTS = ARC_SEGMENTS

export interface SurfaceShapePoints {
  // Outer ring in sketch-plane coordinates, in draw order. The pick path
  // reuses this as the probe's coverage polygon.
  pts: [number, number][]
  // Inner rings, each in draw order.
  holes: [number, number][][]
  query: string
  buildable: boolean
}

export function surfaceShapePoints(topology: Topology): SurfaceShapePoints[] {
  return topology.surfaces.flatMap((surface: TopologySurface) => {
    const pts = tessellateBoundary(surface.boundary, SURFACE_TESSELLATION_SEGMENTS)
    if (pts.length < 3) return []
    const holes: [number, number][][] = []
    for (const hole of surface.holes ?? []) {
      const hpts = tessellateBoundary(hole, SURFACE_TESSELLATION_SEGMENTS)
      if (hpts.length >= 3) holes.push(hpts)
    }
    // Absent stamp = an older/hand-built topology that never ran the gate;
    // treat it as buildable so nothing pre-existing suddenly reads as broken.
    return [{ pts, holes, query: surface.query, buildable: surface.buildable !== false }]
  })
}
