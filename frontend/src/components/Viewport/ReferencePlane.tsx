import { useState, useRef } from 'react'
import { Line, Text } from '@react-three/drei'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { builtinSelectionId } from '../Geometry3D/utils'
import { COLOR_HOVER, COLOR_INACTIVE } from '../Geometry3D/constants'

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
  const [hovered, setHovered] = useState(false)
  const toggleSelect = useSketchEditorStore(s => s.toggleSelect)
  const commitPlaneSelection = useSketchEditorStore(s => s.commitPlaneSelection)
  const planeSelectionFeatureId = useSketchEditorStore(s => s.planeSelectionFeatureId)
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const selId = builtinSelectionId(label)
  const selected = useSketchEditorStore(s => s.selection.has(selId))

  const color = hovered ? COLOR_HOVER : selected ? COLOR_HOVER : COLOR_INACTIVE
  const opacity = hovered ? 0.15 : 0.05
  const isDrawingTool = activeTool !== 'select' && activeTool !== 'dimension'

  return (
    <group rotation={rotation}>
      <mesh
        onPointerOver={e => { if (!isDrawingTool) e.stopPropagation(); setHovered(true) }}
        onPointerOut={() => setHovered(false)}
        onClick={e => {
          e.stopPropagation()
          if (planeSelectionFeatureId) commitPlaneSelection(selId)
          else toggleSelect(selId)
        }}
      >
        <planeGeometry args={[PLANE_SIZE, PLANE_SIZE]} />
        <meshBasicMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <Line points={PLANE_BORDER} color={hovered || selected ? COLOR_HOVER : '#666666'} lineWidth={1} />
      <PlaneLabel x={-PH} y={PH}>{label}</PlaneLabel>
    </group>
  )
}
