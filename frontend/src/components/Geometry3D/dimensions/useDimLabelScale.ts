import { useRef } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { p2w } from '@/components/sketch/sketch_helpers'

/**
 * Ref for a dimension label mesh kept at a constant ~30px on-screen size,
 * rescaling every frame against the current camera. Shared by all dimension
 * label components (Linear / Radial / Diameter / Angle).
 */
export function useDimLabelScale() {
  const meshRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  useFrame(() => {
    if (meshRef.current) meshRef.current.scale.setScalar(30 * p2w(camera))
  })
  return meshRef
}
