import { useRef } from 'react'
import { Line, Text } from '@react-three/drei'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'

const PLANE_SIZE = 1
const PH = PLANE_SIZE / 2
const PLANE_BORDER: [number,number,number][] = [[-PH,-PH,0],[PH,-PH,0],[PH,PH,0],[-PH,PH,0],[-PH,-PH,0]]

function PlaneLabel({ x, y, children }: { x: number; y: number; children: string }) {
  const groupRef = useRef<THREE.Group>(null)
  const { camera } = useThree()
  useFrame(() => {
    if (groupRef.current) {
      const s = 12 / (('zoom' in camera) ? (camera as THREE.OrthographicCamera).zoom : 1)
      groupRef.current.scale.setScalar(s)
    }
  })
  return (
    <group ref={groupRef} position={[x + 0.03, y - 0.02, 0.001]}>
      <Text fontSize={3} color="#888888" fillOpacity={0.20} anchorX="left" anchorY="top">
        {children}
      </Text>
    </group>
  )
}

interface ReferencePlaneProps {
  rotation: [number, number, number]
  label: string
}

export default function ReferencePlane({ rotation, label }: ReferencePlaneProps) {
  return (
    <group rotation={rotation}>
      <mesh>
        <planeGeometry args={[PLANE_SIZE,PLANE_SIZE]} />
        <meshBasicMaterial color="#888888" transparent opacity={0.05} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <Line points={PLANE_BORDER} color="#666666" lineWidth={1} />
      <PlaneLabel x={-PH} y={PH}>{label}</PlaneLabel>
    </group>
  )
}
