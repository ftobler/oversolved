import * as THREE from 'three'
import type { Topology } from '@/types/cad'
import { surfaceShapePoints, SURFACE_TESSELLATION_SEGMENTS } from '@/utils/geometry/surfaceShapes'

// The THREE.Shape wrapper around the shared area outlines. The outline math is
// pure and lives in utils/geometry/surfaceShapes; this is the UI-side builder
// both the visible fill and the pick geometry consume.

export { SURFACE_TESSELLATION_SEGMENTS }

export interface SurfaceShape {
  shape: THREE.Shape
  // Outer ring in sketch-plane coordinates, in draw order.
  pts: [number, number][]
  query: string
  buildable: boolean
}

export function buildSurfaceShapes(topology: Topology): SurfaceShape[] {
  return surfaceShapePoints(topology).map(({ pts, holes, query, buildable }) => {
    const shape = new THREE.Shape()
    shape.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1])
    shape.closePath()
    // Inner loops become THREE.Path holes so a donut renders with its hole and
    // is not pickable as solid material in the middle.
    for (const hpts of holes) {
      const path = new THREE.Path()
      path.moveTo(hpts[0][0], hpts[0][1])
      for (let i = 1; i < hpts.length; i++) path.lineTo(hpts[i][0], hpts[i][1])
      path.closePath()
      shape.holes.push(path)
    }
    return { shape, pts, query, buildable }
  })
}
