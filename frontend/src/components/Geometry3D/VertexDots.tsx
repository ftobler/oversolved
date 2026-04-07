import { useRef, useMemo, useState, useCallback } from 'react'
import { Line } from '@react-three/drei'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { p2w } from '../sketch_helpers'
import { COLOR_HOVER, COLOR_SELECTED, COLOR_CONSTRAINT_HOVER, COLOR_PROJECTED, HIT_PIXELS, POINT_HIT_PIXELS } from './constants'
import type { SnapKind } from '../../registry'

function determineSnapKind(entityKind: string | undefined, vertexKey: string | undefined): SnapKind {
  if (vertexKey === 'center') return 'center'
  if (entityKind === 'point') return 'vertex'
  if (entityKind === 'circle') return 'center'
  return 'vertex'
}

/** 10-gon dot with constant pixel radius regardless of zoom.
 *  If billboard=true the dot always faces the camera. */
export function Dot({ x, y, px, color, billboard = false }: { x: number; y: number; px: number; color: string; billboard?: boolean }) {
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
    <mesh ref={meshRef} position={[x, y, 0]}>
      <circleGeometry args={[1, 10]} />
      <meshBasicMaterial color={color} side={THREE.DoubleSide} />
    </mesh>
  )
}

/** One invisible cylinder per segment. Radius scales to HIT_PIXELS each frame so
 *  coverage is gapless at any zoom. Placed at z=-0.001 so vertex spheres (z=0,
 *  extending to z=+R) always win the raycast at endpoint positions. */
export function HitPolyline({ pts, onPointerOver, onPointerOut, showDebugCollision, showDebugHit }: {
  pts: [number, number, number][]
  onPointerOver: (e: { stopPropagation: () => void }) => void
  onPointerOut: () => void
  showDebugCollision?: boolean
  showDebugHit?: boolean
}) {
  const segRefs = useRef<(THREE.Mesh | null)[]>([])
  const { camera } = useThree()

  // cylinder default axis is Y; rotate so Y aligns with segment direction
  const segs = useMemo(() => pts.slice(0, -1).map((p1, i) => {
    const p2 = pts[i + 1]
    const cx = (p1[0] + p2[0]) / 2, cy = (p1[1] + p2[1]) / 2
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1])
    const angle = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) - Math.PI / 2
    return { cx, cy, len, angle }
  }), [pts])

  useFrame(() => {
    const r = HIT_PIXELS * p2w(camera)
    segRefs.current.forEach((ref, i) => { if (ref) ref.scale.set(r, segs[i].len, r) })
  })

  return (
    <>
      {segs.map((s, i) => s.len > 0 && (
        <mesh key={i} ref={el => { segRefs.current[i] = el }}
          position={[s.cx, s.cy, -0.001]} rotation={[0, 0, s.angle]}
          onPointerOver={onPointerOver} onPointerOut={onPointerOut}
        >
          <cylinderGeometry args={[1, 1, 1, 8, 1]} />
          <meshBasicMaterial transparent opacity={(showDebugCollision ?? showDebugHit) ? 0.25 : 0} color="#ff6600" depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </>
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
 *  of the edge group so hover does not bubble up and highlight the whole entity. */
export function VertexDot({ x, y, px, baseColor, featureId, entityId, vertexKey, entityKind, isEditing = false, showDebugHit }: {
  x: number; y: number; px: number; baseColor: string
  featureId?: string; entityId?: string; vertexKey?: string; entityKind?: string
  isEditing?: boolean; showDebugHit?: boolean
}) {
  // HOVER PATTERN: Local state for visual feedback (fast), store for logic/debug.
  // DO NOT use local hovered state alone - must also call setHoveredVertex().
  const [hovered, setHovered] = useState(false)
  const hitRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  const vertId = featureId && entityId && vertexKey ? `vertex:${featureId}:${entityId}:${vertexKey}` : undefined
  const selected = useSketchEditorStore(s => vertId ? s.selection.has(vertId) : false)
  const toggleSelect = useSketchEditorStore(s => s.toggleSelect)
  const setDrag = useSketchEditorStore(s => s.setDrag)
  const setOrbitEnabled = useSketchEditorStore(s => s.setOrbitEnabled)
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const isRotating = useSketchEditorStore(s => s.isRotating)
  const handleDimClick = useSketchEditorStore(s => s.handleDimensionClick)
  const setHoveredVertex = useSketchEditorStore(s => s.setHoveredVertex)
  const fieldPickState = useSketchEditorStore(s => s.fieldPickState)
  const commitFieldPick = useSketchEditorStore(s => s.commitFieldPick)
  const constraintHovered = useSketchEditorStore(s =>
    entityId && vertexKey ? s.hoveredConstraintEntityIds.has(`${entityId}:${vertexKey}`) : false
  )
  const activeFeatureId = useSketchEditorStore(s => s.activeFeatureId)
  const setIsPointerDown = useSketchEditorStore(s => s.setIsPointerDown)
  const toggleDynamicSelection = useSketchEditorStore(s => s.toggleDynamicSelection)
  const isPointerDown = useSketchEditorStore(s => s.isPointerDown)
  const lastHoveredRef = useRef<string | null>(null)
  // Ref to track vertex that was clicked - prevents it from being added to dynamic selection
  const clickedVertexRef = useRef<string | null>(null)
  // REGRESSION PROTECTION: Hide collision geometry during vertex drag
  // BUG: When dragging a vertex, DragPlane raycasts could be blocked by the
  //      vertex's own hit sphere collision geometry (scaled to HIT_PIXELS).
  //      This caused stalled/choppy dragging when cursor was over the vertex.
  // FIX: Hide collision immediately when drag starts (not just after movement begins).
  // NOTE: Must check featureId, entityId, AND vertexKey to handle all cases.
  // Also hide hit geometry from non-active sketches to prevent raycasting interference.
  // See: src/components/__tests__/dragging.test.ts (REGRESSION 2)
  const isInactiveSketch = featureId && activeFeatureId && featureId !== activeFeatureId
  useFrame(() => {
    if (!hitRef.current) return
    hitRef.current.scale.setScalar(POINT_HIT_PIXELS * p2w(camera))
  })
  const onClick = useCallback((e: { stopPropagation: () => void; clientX: number; clientY: number }) => {
    if (!vertId || !featureId) return
    e.stopPropagation()
    if (activeTool === 'dimension') {
      if (!isEditing) return
      handleDimClick(vertId, featureId, 'vertex', [e.clientX, e.clientY])
    } else if (fieldPickState?.kind === 'point') {
      commitFieldPick(vertId)
    } else {
      toggleSelect(vertId)
    }
  }, [vertId, featureId, toggleSelect, activeTool, handleDimClick, isEditing, fieldPickState, commitFieldPick])
  const onPointerDown = useCallback((e: { stopPropagation: () => void; point: THREE.Vector3; clientX: number; clientY: number }) => {
    if (!vertId || !featureId || !entityId || !vertexKey) return
    if (!isEditing || activeTool !== 'select') return
    e.stopPropagation()
    setOrbitEnabled(false)

    // Mark this vertex as the click initiator - prevents it from being added to dynamic selection
    clickedVertexRef.current = vertId

    // Dynamic selection: track pointer down state
    setIsPointerDown(true)

    // startClient is screen pixel coordinates at pointer-down; used to distinguish clicks from drags.
    // Must be the actual cursor position, not the vertex center, so that pure clicks (cursor barely
    // moves) don't emit spurious move mutations. See: dragging.test.ts REGRESSION 4
    setDrag({
      type: 'vertex',
      vertexId: vertId,
      featureId,
      entityId,
      vertexKey,
      startWorld: [x, y],
      currentWorld: [x, y],
      startClient: [e.clientX, e.clientY],
    })
  }, [isEditing, vertId, featureId, entityId, vertexKey, x, y, setDrag, setOrbitEnabled, activeTool, setIsPointerDown])
  const color = hovered ? COLOR_HOVER : selected ? COLOR_SELECTED : constraintHovered ? COLOR_CONSTRAINT_HOVER : baseColor
  const isDrawingTool = activeTool !== 'select' && activeTool !== 'dimension'
  const snapKind = determineSnapKind(entityKind, vertexKey)
  const handlePointerOver = (e: { stopPropagation: () => void }) => {
    if (isRotating) return
    if (!isDrawingTool) e.stopPropagation()
    setHovered(true)
    if (vertId) setHoveredVertex(vertId, [x, y], snapKind)

    // Dynamic selection: add to set if pointer is down and not already processed
    // Exclude the vertex that was clicked (drag initiator) to avoid self-referencing
    if (isPointerDown && vertId && lastHoveredRef.current !== vertId && clickedVertexRef.current !== vertId) {
      lastHoveredRef.current = vertId
      toggleDynamicSelection(vertId)
    }
  }
  const handlePointerOut = () => {
    if (isRotating) return
    lastHoveredRef.current = null
    // Clear click initiator when leaving the vertex
    if (clickedVertexRef.current === vertId) {
      clickedVertexRef.current = null
    }
    setHovered(false)
    setHoveredVertex(null, null, null)
  }
  return (
    <group
      onPointerOver={handlePointerOver}
      onPointerOut={handlePointerOut}
      onClick={onClick}
      onPointerDown={onPointerDown}
    >
      <Dot x={x} y={y} px={hovered ? px + 2 : px} color={color} billboard />
      {(hovered || selected || constraintHovered) && <VertexHighlight x={x} y={y} px={POINT_HIT_PIXELS * 0.3} color={color} />}
      {!isInactiveSketch && (
        <mesh ref={hitRef} position={[x, y, 0]}>
          <sphereGeometry args={[1, 8, 8]} />
          <meshBasicMaterial transparent opacity={showDebugHit ? 0.35 : 0} color="#00aaff" depthWrite={false} />
        </mesh>
      )}
    </group>
  )
}

/** Cross/plus marker at constant pixel size for a projected reference point.
 *  Clickable with the dimension tool; not draggable. */
export function ProjectedOriginPoint({ x, y, featureId, entityId }: { x: number; y: number; featureId: string; entityId: string }) {
  const [hovered, setHovered] = useState(false)
  const groupRef = useRef<THREE.Group>(null)
  const hitRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const handleDimClick = useSketchEditorStore(s => s.handleDimensionClick)
  const toggleSelect = useSketchEditorStore(s => s.toggleSelect)
  const activeFeatureId = useSketchEditorStore(s => s.activeFeatureId)
  const isRotating = useSketchEditorStore(s => s.isRotating)
  const entId = `entity:${featureId}:${entityId}`
  const selected = useSketchEditorStore(s => s.selection.has(entId))
  const constraintHovered = useSketchEditorStore(s => s.hoveredConstraintEntityIds.has(entityId))

  useFrame(() => {
    const scale = 7 * p2w(camera)
    if (groupRef.current) groupRef.current.scale.setScalar(scale)
    if (hitRef.current) hitRef.current.scale.setScalar(POINT_HIT_PIXELS * p2w(camera))
  })
  const onClick = useCallback((e: { stopPropagation: () => void; clientX: number; clientY: number }) => {
    e.stopPropagation()
    if (activeTool === 'dimension') {
      if (activeFeatureId !== featureId) return
      handleDimClick(entId, featureId, 'entity', [e.clientX, e.clientY], 'point')
    } else {
      toggleSelect(entId)
    }
  }, [activeTool, featureId, entId, toggleSelect, handleDimClick, activeFeatureId])
  const color = hovered ? COLOR_HOVER : selected ? COLOR_SELECTED : constraintHovered ? COLOR_CONSTRAINT_HOVER : COLOR_PROJECTED
  const isDrawingTool = activeTool !== 'select' && activeTool !== 'dimension'
  const handlePointerOver = (e: { stopPropagation: () => void }) => {
    if (isRotating) return
    if (!isDrawingTool) e.stopPropagation()
    setHovered(true)
  }
  const handlePointerOut = () => {
    if (isRotating) return
    setHovered(false)
  }
  return (
    <group ref={groupRef} position={[x, y, 0]}
      onPointerOver={handlePointerOver}
      onPointerOut={handlePointerOut}
    >
      {/* '+' cross: vertical bar */}
      <Line points={[[0, -1, 0], [0, 1, 0]]} color={color} lineWidth={hovered ? 2 : 1} />
      {/* '+' cross: horizontal bar */}
      <Line points={[[-1, 0, 0], [1, 0, 0]]} color={color} lineWidth={hovered ? 2 : 1} />
      {/* Hit sphere for clicking */}
      <mesh ref={hitRef} position={[0, 0, 0]} onClick={onClick}>
        <sphereGeometry args={[1, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  )
}
