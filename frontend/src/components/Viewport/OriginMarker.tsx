import { useState, useRef, useCallback } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { builtinSelectionId } from '@/components/Geometry3D/utils'
import { COLOR_HOVER, COLOR_SELECTED, COLOR_INACTIVE, POINT_HIT_PIXELS, POINT_HIT_PIXELS_Z_OFFSET } from '@/components/Geometry3D/constants'
import { Dot, VertexHighlight } from '@/components/Geometry3D/VertexDots'
import { p2w } from '@/components/sketch_helpers'
import { useToolClickDispatch } from '@/components/Geometry3D/useToolClickDispatch'

export default function OriginMarker() {
  const [hovered, setHovered] = useState(false)
  const hitRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  const setHoveredEntity = useSketchEditorStore(s => s.setHoveredEntity)
  const setHoveredVertex = useSketchEditorStore(s => s.setHoveredVertex)
  const selId = builtinSelectionId('Origin')
  const selected = useSketchEditorStore(s => s.normalSelection.has(selId))
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const activeFeatureId = useSketchEditorStore(s => s.activeFeatureId)
  const isRotating = useSketchEditorStore(s => s.isRotating)
  const isEditing = !!activeFeatureId

  const onClick = useToolClickDispatch({ id: selId, isEditing })

  useFrame(() => {
    if (!hitRef.current) return
    const scale = p2w(camera)
    hitRef.current.scale.setScalar(POINT_HIT_PIXELS * scale)
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion)
    const off = POINT_HIT_PIXELS_Z_OFFSET * scale
    hitRef.current.position.set(fwd.x * off, fwd.y * off, fwd.z * off)
  })

  const color = hovered ? COLOR_HOVER : selected ? COLOR_SELECTED : COLOR_INACTIVE
  const isDrawingTool = (activeTool ?? 'drag') !== 'select' && (activeTool ?? 'drag') !== 'dimension'

  const handlePointerOver = useCallback((e: { stopPropagation: () => void }) => {
    if (isRotating) return
    if (!isDrawingTool) e.stopPropagation()
    setHovered(true)
    setHoveredEntity(selId)
    setHoveredVertex(selId, [0, 0], 'vertex')
  }, [isRotating, isDrawingTool, selId, setHoveredEntity, setHoveredVertex])

  const handlePointerOut = useCallback(() => {
    if (isRotating) return
    setHovered(false)
    setHoveredEntity(null)
    setHoveredVertex(null, null, null)
  }, [isRotating, setHoveredEntity, setHoveredVertex])

  return (
    <group
      onPointerOver={handlePointerOver}
      onPointerOut={handlePointerOut}
      onClick={onClick}
    >
      <Dot x={0} y={0} px={hovered ? 6 : 4} color={color} billboard />
      {(hovered || selected) && <VertexHighlight x={0} y={0} px={POINT_HIT_PIXELS * 0.3} color={color} />}
      <mesh ref={hitRef}>
        <sphereGeometry args={[1, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} color="#00aaff" depthWrite={false} />
      </mesh>
    </group>
  )
}
