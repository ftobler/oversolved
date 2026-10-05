import * as THREE from 'three'
import { useIdPipeline } from './IdPipelineContext'
import { useRegisteredBody } from './idRegistrationUtils'
import { isDevBuild } from '@/kernel/isDevBuild'

/**
 * Register a single rectangular plane quad with the planeFace ID layer.
 *
 * The plane is expressed as a transform + size: in plane-local space it is
 * an axis-aligned square spanning [-size/2, +size/2] x [-size/2, +size/2]
 * at z=0. The hook transforms the four corners into world space using the
 * provided rotation (Euler XYZ) and origin, then registers two triangles
 * with the plane's selection ID as their face query.
 */
export function usePlaneIdRegistration(params: {
  // Stable selection ID used as the entity query, e.g. `@builtin_plane_top` or `@feat1`.
  selectionId: string
  // Plane size in world units (square).
  size: number
  // Euler XYZ rotation applied to the plane. Defaults to identity.
  rotation?: [number, number, number]
  // World-space origin of the plane center. Defaults to (0,0,0).
  origin?: [number, number, number]
  enabled?: boolean
}): void {
  const pipeline = useIdPipeline()
  const { selectionId, size, rotation, origin, enabled = true } = params
  const rx = rotation?.[0] ?? 0, ry = rotation?.[1] ?? 0, rz = rotation?.[2] ?? 0
  const ox = origin?.[0] ?? 0, oy = origin?.[1] ?? 0, oz = origin?.[2] ?? 0

  useRegisteredBody(pipeline, enabled, selectionId,
    (p) => {
      const half = size / 2
      const corners: [number, number, number][] = [
        [-half, -half, 0], [+half, -half, 0], [+half, +half, 0], [-half, +half, 0],
      ]
      const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ'))
      m.setPosition(ox, oy, oz)
      const v = new THREE.Vector3()
      const world = corners.map(([x, y, z]) => {
        v.set(x, y, z).applyMatrix4(m)
        return [v.x, v.y, v.z] as [number, number, number]
      })
      const positions = new Float32Array([
        ...world[0], ...world[1], ...world[2],
        ...world[0], ...world[2], ...world[3],
      ])
      const triangleToFace = new Uint32Array([0, 0])
      const faceQueries = [selectionId]
      try {
        p.planeLayer.registerBody({ bodyKey: selectionId, positions, triangleToFace, faceQueries })
        return true
      } catch (err) {
        // A registerBody throw in a passive effect has no error boundary above
        // it and would unmount the viewport root. Match the body hooks: warn
        // and return false so useRegisteredBody skips markDirty.
        if (isDevBuild()) console.warn('Plane ID registration failed; continuing without it', { selectionId, err })
        return false
      }
    },
    (p) => p.planeLayer.unregisterBody(selectionId),
    [selectionId, size, rx, ry, rz, ox, oy, oz],
  )
}
