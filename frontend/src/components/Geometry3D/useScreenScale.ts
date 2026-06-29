import { useRef } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { p2w } from '@/utils/geometry/sketchHelpers'
import { applyWorldBillboard } from '@/components/Geometry3D/billboard'

/**
 * Ref for an object kept at a constant on-screen pixel size, rescaling every
 * frame against the current camera. Pass `billboard` to also keep it facing
 * the camera. The pixel size may change between renders (e.g. on hover); the
 * latest value is used because the frame callback closes over it each render.
 */
export function useScreenScale<T extends THREE.Object3D = THREE.Object3D>(
  px: number,
  opts?: { billboard?: boolean },
) {
  const ref = useRef<T>(null)
  const { camera } = useThree()
  useFrame(() => {
    if (!ref.current) return
    ref.current.scale.setScalar(px * p2w(camera))
    if (opts?.billboard) applyWorldBillboard(ref.current, camera)
  })
  return ref
}
