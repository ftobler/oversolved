import { useRef } from 'react'
import { Line } from '@react-three/drei'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'

const AXIS_LEN = 0.35

function OriginDot() {
  const meshRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  useFrame(() => {
    if (meshRef.current) {
      const s = 4 * (1 / (('zoom' in camera) ? (camera as THREE.OrthographicCamera).zoom : 1))
      meshRef.current.scale.setScalar(s)
    }
  })
  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[1, 8, 8]} />
      <meshBasicMaterial color="#ffffff" />
    </mesh>
  )
}

export default function OriginMarker() {
  return (
    <group>
      <Line points={[[0,0,0],[AXIS_LEN,0,0]]} color="#e53935" lineWidth={2} />
      <Line points={[[0,0,0],[0,AXIS_LEN,0]]} color="#43a047" lineWidth={2} />
      <Line points={[[0,0,0],[0,0,AXIS_LEN]]} color="#1e88e5" lineWidth={2} />
      <OriginDot />
    </group>
  )
}
