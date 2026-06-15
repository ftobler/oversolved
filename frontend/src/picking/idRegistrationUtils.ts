import * as THREE from 'three'
import type { PlaneTransform } from '@/types/cad'

export function buildPlaneMatrix(planeTransform?: PlaneTransform): THREE.Matrix4 {
  const m = new THREE.Matrix4()
  if (!planeTransform) return m
  const [x0, x1, x2, y0, y1, y2, n0, n1, n2] = planeTransform.rotation
  m.set(
    x0, y0, n0, 0,
    x1, y1, n1, 0,
    x2, y2, n2, 0,
    0,  0,  0,  1,
  )
  const o = planeTransform.origin
  m.setPosition(o[0] ?? 0, o[1] ?? 0, o[2] ?? 0)
  return m
}
