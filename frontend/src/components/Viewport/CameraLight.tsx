import { useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

export default function CameraLight() {
  const lightRef = useRef<THREE.PointLight>(null)
  const { camera } = useThree()

  useFrame(() => {
    if (!lightRef.current) return
    // Place light in the same direction as the camera but much closer
    // to the scene so surfaces show a visible distance falloff.
    lightRef.current.position.copy(camera.position).multiplyScalar(0.1)
  })

  return (
    <>
      <ambientLight intensity={0.45} />
      <pointLight ref={lightRef} intensity={600} distance={0} decay={3} />
    </>
  )
}