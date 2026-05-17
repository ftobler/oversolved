import { useRef } from 'react'
import { Line } from '@react-three/drei'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { p2w } from '@/components/sketch_helpers'
import { COLOR_HOVER, COLOR_SELECTED, COLOR_CONSTRAINT_HOVER, COLOR_PROJECTED, POINT_HIT_PIXELS, RENDER_ORDER_EDITING } from '@/components/Geometry3D/constants'

/** 10-gon dot with constant pixel radius regardless of zoom.
 *  If billboard=true the dot always faces the camera.
 *  renderOrder and depthTest control z-ordering (use for always-on-top elements). */
export function Dot({ x, y, px, color, billboard = false, renderOrder = 0, depthTest = true }: {
  x: number; y: number; px: number; color: string; billboard?: boolean; renderOrder?: number; depthTest?: boolean
}) {
  const meshRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  useFrame(() => {
    if (!meshRef.current) return
    meshRef.current.scale.setScalar(px * p2w(camera))
    if (billboard) {
      // Billboard in world space: undo parent world rotation before applying camera quaternion
      const parentQuat = new THREE.Quaternion()
      meshRef.current.parent?.getWorldQuaternion(parentQuat)
      meshRef.current.quaternion.copy(camera.quaternion).premultiply(parentQuat.invert())
    }
  })
  return (
    <mesh ref={meshRef} position={[x, y, 0]} renderOrder={renderOrder}>
      <circleGeometry args={[1, 10]} />
      <meshBasicMaterial color={color} side={THREE.DoubleSide} depthTest={depthTest} transparent={!depthTest} />
    </mesh>
  )
}

// Square highlight rendered at z=0.001 so it's always visible above lines.
export function VertexHighlight({ x, y, px, color }: { x: number; y: number; px: number; color: string }) {
  const groupRef = useRef<THREE.Group>(null)
  const { camera } = useThree()
  useFrame(() => {
    if (!groupRef.current) return
    groupRef.current.scale.setScalar(px * p2w(camera))
    // Billboard in world space: undo parent world rotation before applying camera quaternion
    const parentQuat = new THREE.Quaternion()
    groupRef.current.parent?.getWorldQuaternion(parentQuat)
    groupRef.current.quaternion.copy(camera.quaternion).premultiply(parentQuat.invert())
  })
  const h = 1.4 // half-size of square in local units
  const pts: [number, number, number][] = [[-h, -h, 0], [h, -h, 0], [h, h, 0], [-h, h, 0], [-h, -h, 0]]
  return (
    <group ref={groupRef} position={[x, y, 0]}>
      <Line points={pts} color={color} lineWidth={2} />
    </group>
  )
}

/** Vertex dot with its own independent hover state. Placed as a sibling (not child)
 *  of the edge group so hover does not bubble up and highlight the whole entity.
 *
 *  As of 267.5 the ID buffer dispatcher handles all picking; this component
 *  is visual-only — no R3F event props. */
export function VertexDot({ x, y, px, baseColor, featureId, entityId, vertexKey, showDebugHit }: {
  x: number; y: number; px: number; baseColor: string
  featureId?: string; entityId?: string; vertexKey?: string
  isEditing?: boolean; showDebugHit?: boolean
}) {
  const hitRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  const vertId = featureId && entityId && vertexKey ? `vertex:${featureId}:${entityId}:${vertexKey}` : undefined

  // Store reads for display and collision hiding.
  const constraintHovered = useSketchEditorStore(s =>
    entityId && vertexKey ? s.hoveredConstraintEntityIds.has(`${entityId}:${vertexKey}`) : false
  )
  const hoveredVertexId = useSketchEditorStore(s => s.hoveredVertexId)
  const activeFeatureId = useSketchEditorStore(s => s.activeFeatureId)
  const drag = useSketchEditorStore(s => s.drag)
  const selected = useSketchEditorStore(s => vertId ? s.normalSelection.has(vertId) : false)
  const isInactiveSketch = featureId && activeFeatureId && featureId !== activeFeatureId
  const isDraggedVertex = drag && drag.type === 'vertex' && drag.entityId === entityId && drag.featureId === featureId

  // Hover state is now driven by the ID-buffer dispatcher (267.5).
  const hovered = vertId ? hoveredVertexId === vertId : false

  useFrame(() => {
    if (!hitRef.current) return
    hitRef.current.scale.setScalar(POINT_HIT_PIXELS * p2w(camera))
  })

  const color = hovered ? COLOR_HOVER : selected ? COLOR_SELECTED : constraintHovered ? COLOR_CONSTRAINT_HOVER : baseColor

  return (
    <group>
      <Dot x={x} y={y} px={hovered ? px + 2 : px} color={color} billboard renderOrder={selected ? RENDER_ORDER_EDITING : 0} depthTest={!selected} />
      {(hovered || selected || constraintHovered) && <VertexHighlight x={x} y={y} px={POINT_HIT_PIXELS * 0.3} color={color} />}
      {!isInactiveSketch && !isDraggedVertex && (
        <mesh ref={hitRef} position={[x, y, 0]}>
          <sphereGeometry args={[1, 8, 8]} />
          <meshBasicMaterial transparent opacity={showDebugHit ? 0.35 : 0} color="#00aaff" depthWrite={false} />
        </mesh>
      )}
    </group>
  )
}

/** Cross/plus marker at constant pixel size for a projected reference point.
 *
 *  As of 267.5 the ID buffer dispatcher handles all picking; this component
 *  is visual-only — no R3F event props. */
export function ProjectedOriginPoint({ x, y, featureId, entityId }: { x: number; y: number; featureId: string; entityId: string }) {
  const groupRef = useRef<THREE.Group>(null)
  const hitRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  const entId = `entity:${featureId}:${entityId}`
  const selected = useSketchEditorStore(s => s.normalSelection.has(entId))
  const constraintHovered = useSketchEditorStore(s => s.hoveredConstraintEntityIds.has(entityId))
  const internalHoverSelection = useSketchEditorStore(s => s.internalHoverSelection)

  // Hover state is now driven by the ID-buffer dispatcher (267.5).
  const hovered = internalHoverSelection === entId

  useFrame(() => {
    const scale = 7 * p2w(camera)
    if (groupRef.current) groupRef.current.scale.setScalar(scale)
    if (hitRef.current) hitRef.current.scale.setScalar(POINT_HIT_PIXELS * p2w(camera))
  })

  const color = hovered ? COLOR_HOVER : selected ? COLOR_SELECTED : constraintHovered ? COLOR_CONSTRAINT_HOVER : COLOR_PROJECTED
  return (
    <group ref={groupRef} position={[x, y, 0]}>
      {/* '+' cross: vertical bar */}
      <Line points={[[0, -1, 0], [0, 1, 0]]} color={color} lineWidth={hovered ? 2 : 1} />
      {/* '+' cross: horizontal bar */}
      <Line points={[[-1, 0, 0], [1, 0, 0]]} color={color} lineWidth={hovered ? 2 : 1} />
      {/* Hit sphere for clicking */}
      <mesh ref={hitRef} position={[0, 0, 0]}>
        <sphereGeometry args={[1, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  )
}
