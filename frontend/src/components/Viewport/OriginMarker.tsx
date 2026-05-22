import { useRef } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { builtinSelectionId } from '@/components/Geometry3D/utils'
import { COLOR_HOVER, COLOR_SELECTED, COLOR_INACTIVE, POINT_HIT_PIXELS, POINT_HIT_PIXELS_Z_OFFSET } from '@/components/Geometry3D/constants'
import { Dot } from '@/components/Geometry3D/VertexDots'
import { p2w } from '@/components/sketch_helpers'
import { useOriginMarkerIdRegistration } from '@/picking'

export default function OriginMarker() {
  const hitRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  const selId = builtinSelectionId('Origin')
  const selected = useSketchEditorStore(s => s.normalSelection.has(selId))
  const hoveredSelectionId = useSketchEditorStore(s => s.hoveredSelectionId)

  const hovered = hoveredSelectionId === selId

  useOriginMarkerIdRegistration({ selectionId: selId })

  useFrame(() => {
    if (!hitRef.current) return
    const scale = p2w(camera)
    hitRef.current.scale.setScalar(POINT_HIT_PIXELS * scale)
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion)
    const off = POINT_HIT_PIXELS_Z_OFFSET * scale
    hitRef.current.position.set(fwd.x * off, fwd.y * off, fwd.z * off)
  })

  const color = hovered ? COLOR_HOVER : selected ? COLOR_SELECTED : COLOR_INACTIVE

  return (
    <group>
      <Dot x={0} y={0} px={hovered ? 6 : 4} color={color} billboard renderOrder={999} depthTest={false} />
      <mesh ref={hitRef}>
        <sphereGeometry args={[1, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} color="#00aaff" depthWrite={false} />
      </mesh>
    </group>
  )
}
