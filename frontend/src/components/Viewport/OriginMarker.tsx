import { useState, useRef, useCallback } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { builtinSelectionId } from '../Geometry3D/utils'
import { COLOR_HOVER, COLOR_SELECTED, COLOR_INACTIVE, POINT_HIT_PIXELS, POINT_HIT_PIXELS_Z_OFFSET, DEBUG_HIT } from '../Geometry3D/constants'
import { Dot, VertexHighlight } from '../Geometry3D/VertexDots'
import { p2w } from '../sketch_helpers'

export default function OriginMarker() {
  const [hovered, setHovered] = useState(false)
  const hitRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  const toggleSelect = useSketchEditorStore(s => s.toggleSelect)
  const selId = builtinSelectionId('Origin')
  const selected = useSketchEditorStore(s => s.selection.has(selId))
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const handleDimClick = useSketchEditorStore(s => s.handleDimensionClick)
  const activeFeatureId = useSketchEditorStore(s => s.activeFeatureId)

  useFrame(() => {
    if (!hitRef.current) return
    const scale = p2w(camera)
    hitRef.current.scale.setScalar(POINT_HIT_PIXELS * scale)
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion)
    const off = POINT_HIT_PIXELS_Z_OFFSET * scale
    hitRef.current.position.set(fwd.x * off, fwd.y * off, fwd.z * off)
  })

  const onClick = useCallback((e: { stopPropagation: () => void; clientX: number; clientY: number }) => {
    e.stopPropagation()
    if (activeTool === 'dimension' && activeFeatureId) {
      handleDimClick(selId, activeFeatureId, 'vertex', [e.clientX, e.clientY])
    } else {
      toggleSelect(selId)
    }
  }, [activeTool, activeFeatureId, selId, handleDimClick, toggleSelect])

  const color = hovered ? COLOR_HOVER : selected ? COLOR_SELECTED : COLOR_INACTIVE

  return (
    <group
      onPointerOver={e => { e.stopPropagation(); setHovered(true) }}
      onPointerOut={() => setHovered(false)}
      onClick={onClick}
    >
      <Dot x={0} y={0} px={hovered ? 6 : 4} color={color} billboard />
      {(hovered || selected) && <VertexHighlight x={0} y={0} px={POINT_HIT_PIXELS * 0.3} color={color} />}
      <mesh ref={hitRef}>
        <sphereGeometry args={[1, 8, 8]} />
        <meshBasicMaterial transparent opacity={DEBUG_HIT ? 0.35 : 0} color="#00aaff" depthWrite={false} />
      </mesh>
    </group>
  )
}
