import { useCallback, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { Line, Text } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { PlaneTransform } from '../../types/cad'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { planeRotationFromTransform } from '../Geometry3D/utils'
import { COLOR_SELECTED, COLOR_HOVER } from '../Geometry3D/constants'
import { useHoverAndDynamicSelection } from '../Geometry3D/useHoverAndDynamicSelection'

const UDPLANE_SIZE = 1
const UDPH = UDPLANE_SIZE / 2
const UDPLANE_BORDER: [number, number, number][] = [
  [-UDPH, -UDPH, 0], [UDPH, -UDPH, 0], [UDPH, UDPH, 0], [-UDPH, UDPH, 0], [-UDPH, -UDPH, 0],
]

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

/** Encapsulates click routing for plane elements:
 *  1. plane selection mode active  -> commitPlaneSelection
 *  2. pendingPickField set         -> toggleNormalSelection + commitFieldPick
 *  3. otherwise                    -> toggleNormalSelection */
function usePlaneClickDispatch(selId: string): (e: { stopPropagation: () => void }) => void {
  const toggleNormalSelection = useSketchEditorStore(s => s.toggleNormalSelection)
  const commitPlaneSelection = useSketchEditorStore(s => s.commitPlaneSelection)
  const planeSelectionFeatureId = useSketchEditorStore(s => s.planeSelectionFeatureId)
  const pendingPickField = useSketchEditorStore(s => s.pendingPickField)
  const commitFieldPick = useSketchEditorStore(s => s.commitFieldPick)

  return useCallback((e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    if (planeSelectionFeatureId) commitPlaneSelection(selId)
    else {
      toggleNormalSelection(selId)
      if (pendingPickField) commitFieldPick()
    }
  }, [selId, pendingPickField, commitFieldPick, planeSelectionFeatureId, commitPlaneSelection, toggleNormalSelection])
}

export default function UserDefinedPlane({
  featureId,
  label,
  planeTransform,
}: {
  featureId: string
  label: string
  planeTransform: PlaneTransform
}) {
  const drag = useSketchEditorStore(s => s.drag)
  const setHoveredPlane = useSketchEditorStore(s => s.setHoveredPlane)
  const selected = useSketchEditorStore(s => s.normalSelection.has(`@${featureId}`))
  const isDragging = drag !== null
  const selId = `@${featureId}`

  const { hovered, onOver, onOut } = useHoverAndDynamicSelection({
    id: selId,
    hoverPayload: useCallback(() => setHoveredPlane(selId), [setHoveredPlane, selId]),
    clearHoverPayload: useCallback(() => setHoveredPlane(null), [setHoveredPlane]),
  })

  const onClick = usePlaneClickDispatch(selId)

  const rot = planeRotationFromTransform(planeTransform)
  const [ox, oy, oz] = planeTransform.origin

  const color = hovered ? COLOR_HOVER : selected ? COLOR_SELECTED : '#444444'
  const opacity = hovered ? 0.15 : selected ? 0.12 : 0.05

  return (
    <group position={[ox, oy, oz]} rotation={rot}>
      {!isDragging && (
        <mesh onPointerOver={onOver} onPointerOut={onOut} onClick={onClick}>
          <planeGeometry args={[UDPLANE_SIZE, UDPLANE_SIZE]} />
          <meshBasicMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      )}
      <Line points={UDPLANE_BORDER} color={hovered ? COLOR_HOVER : selected ? COLOR_SELECTED : '#666666'} lineWidth={1} />
      <PlaneLabel x={-UDPH} y={UDPH}>{label}</PlaneLabel>
    </group>
  )
}
