import { useState, useRef } from 'react'
import { Line } from '@react-three/drei'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { builtinSelectionId } from '../Geometry3D/utils'
import { COLOR_HOVER } from '../Geometry3D/constants'

const AXIS_LEN = 0.35

function OriginDot({ hovered, selected }: { hovered: boolean; selected: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  useFrame(() => {
    if (meshRef.current) {
      const s = 4 * (1 / (('zoom' in camera) ? (camera as THREE.OrthographicCamera).zoom : 1))
      meshRef.current.scale.setScalar(s)
    }
  })
  const color = hovered || selected ? COLOR_HOVER : '#ffffff'
  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[1, 8, 8]} />
      <meshBasicMaterial color={color} />
    </mesh>
  )
}

export default function OriginMarker() {
  const [hovered, setHovered] = useState(false)
  const toggleSelect = useSketchEditorStore(s => s.toggleSelect)
  const selId = builtinSelectionId('Origin')
  const selected = useSketchEditorStore(s => s.selection.has(selId))

  return (
    <group
      onPointerOver={e => { e.stopPropagation(); setHovered(true) }}
      onPointerOut={() => setHovered(false)}
      onClick={e => { e.stopPropagation(); toggleSelect(selId) }}
    >
      <Line points={[[0,0,0],[AXIS_LEN,0,0]]} color="#e53935" lineWidth={2} />
      <Line points={[[0,0,0],[0,AXIS_LEN,0]]} color="#43a047" lineWidth={2} />
      <Line points={[[0,0,0],[0,0,AXIS_LEN]]} color="#1e88e5" lineWidth={2} />
      <OriginDot hovered={hovered} selected={selected} />
    </group>
  )
}
