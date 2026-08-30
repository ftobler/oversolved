import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useIdPipeline } from './IdPipelineContext'
import type { Topology, PlaneTransform } from '@/types/cad'
import { buildPlaneMatrix } from './idRegistrationUtils'
import { planeTransformKey } from './planeTransformKey'
import { tessellateBoundary } from '@/kernel/topologyBoundary'

/**
 * Register a sketch's topology surfaces with the sketchSurface ID layer.
 *
 * Each topology surface is triangulated via THREE.ShapeGeometry, then
 * every triangle is registered with the surface's ancestral query so
 * the resolver can identify which surface was clicked.
 *
 * The plane transform is applied so surface vertices land at the same
 * world-space positions as the visible SurfaceMesh geometry.
 *
 * Every surface is registered, INCLUDING one topologyDecorate stamped
 * `buildable: false`. Filtering those out would make an area that the viewport
 * still draws unclickable, which reads as a dead spot rather than as a problem:
 * the user has to be able to pick it to find out why it will not extrude. The
 * muted fill in Surfaces.tsx carries the warning; the `reason` string rides on
 * the surface for whatever consumes the pick.
 */

function buildSurfaceShapes(topology: Topology): { shape: THREE.Shape; query: string }[] {
  const results: { shape: THREE.Shape; query: string }[] = []
  for (const surface of topology.surfaces) {
    const pts = tessellateBoundary(surface.boundary, 32)
    if (pts.length < 3) continue
    const shape = new THREE.Shape()
    shape.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1])
    shape.closePath()
    // Subtract inner loops so a donut's hole is not pickable as solid material.
    for (const hole of surface.holes ?? []) {
      const hpts = tessellateBoundary(hole, 32)
      if (hpts.length < 3) continue
      const path = new THREE.Path()
      path.moveTo(hpts[0][0], hpts[0][1])
      for (let i = 1; i < hpts.length; i++) path.lineTo(hpts[i][0], hpts[i][1])
      path.closePath()
      shape.holes.push(path)
    }
    results.push({ shape, query: surface.query })
  }
  return results
}

export function useSketchSurfaceIdRegistration(params: {
  featureId: string
  topology: Topology | undefined
  planeTransform?: PlaneTransform
  enabled?: boolean
}): void {
  const pipeline = useIdPipeline()
  const { featureId, topology, planeTransform, enabled = true } = params

  const planeKey = useMemo(() => planeTransformKey(planeTransform), [planeTransform])

  useEffect(() => {
    if (!enabled) return
    if (!pipeline) return
    if (!topology || topology.surfaces.length === 0) return

    const m = buildPlaneMatrix(planeTransform)
    const v = new THREE.Vector3()
    const surfaces = buildSurfaceShapes(topology)

    // Register as one body per surface, each carrying its triangles.
    for (const { shape, query } of surfaces) {
      const geo = new THREE.ShapeGeometry(shape)
      geo.computeVertexNormals()
      const indexed = geo.getAttribute('position')
      if (!indexed || indexed.count < 3) {
        geo.dispose()
        continue
      }
      const indexAttr = geo.index
      if (!indexAttr) {
        geo.dispose()
        continue
      }

      const numTris = indexAttr.count / 3
      const positions = new Float32Array(numTris * 9)
      const tri2face = new Uint32Array(numTris)

      for (let tri = 0; tri < numTris; tri++) {
        for (let vtx = 0; vtx < 3; vtx++) {
          const srcIdx = indexAttr.getX(tri * 3 + vtx)
          v.set(indexed.getX(srcIdx), indexed.getY(srcIdx), 0).applyMatrix4(m)
          const dst = (tri * 3 + vtx) * 3
          positions[dst]     = v.x
          positions[dst + 1] = v.y
          positions[dst + 2] = v.z
        }
        tri2face[tri] = 0  // all triangles map to the single face (this surface)
      }
      geo.dispose()

      const bodyKey = `${featureId}/${query}`
      try {
        pipeline.sketchSurfaceLayer.registerBody({
          bodyKey,
          positions,
          triangleToFace: tri2face,
          faceQueries: [query],
        })
      } catch (err) {
        console.warn('Sketch surface ID registration failed', { bodyKey, err })
      }
    }

    pipeline.markDirty()

    return () => {
      for (const { query } of surfaces) {
        pipeline.sketchSurfaceLayer.unregisterBody(`${featureId}/${query}`)
      }
      pipeline.markDirty()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- effect must retrigger only on the listed shape keys, not on every surface identity
  }, [pipeline, featureId, topology, planeKey, enabled])
}
