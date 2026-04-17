import { useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

export default function CameraLight() {
  const lightRef = useRef<THREE.DirectionalLight>(null)
  const { camera } = useThree()

  useFrame(() => {
    if (!lightRef.current) return
    lightRef.current.position.copy(camera.position)
    lightRef.current.target.position.set(-50, -50, 0)
    lightRef.current.target.updateMatrixWorld()
  })

  return (
    <>
      <ambientLight intensity={0.45} />
      <directionalLight ref={lightRef} intensity={0.9} />
    </>
  )
}