import { useRef, useMemo, useCallback } from 'react'
import { useDragInitiation } from './useDragInitiation'
import { Line } from '@react-three/drei'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { p2w } from '../sketch_helpers'
import { COLOR_HOVER, COLOR_SELECTED, COLOR_CONSTRAINT_HOVER, COLOR_PROJECTED, HIT_PIXELS, POINT_HIT_PIXELS } from './constants'
import type { SnapKind } from '../../registry'
import { useHoverAndDynamicSelection } from './useHoverAndDynamicSelection'
import { useToolClickDispatch } from './useToolClickDispatch'

/** Derive snap kind from the hover target. All point handles (line endpoints,
 *  circle centers, point xy) are broadly categorized as 'vertex'. */
function determineSnapKind(): SnapKind {
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PointerHandler = (e: any) => void

export function HitPolyline({ pts, showDebugCollision, showDebugHit, onClick, onPointerDown, onPointerOver, onPointerOut }: {
  pts: [number, number, number][]
  showDebugCollision?: boolean
  showDebugHit?: boolean
  onClick?: PointerHandler
  onPointerDown?: PointerHandler
  onPointerOver?: PointerHandler
  onPointerOut?: PointerHandler
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
          onClick={onClick}
          onPointerDown={onPointerDown}
          onPointerOver={onPointerOver}
          onPointerOut={onPointerOut}
        >
          <cylinderGeometry args={[1, 1, 1, 8, 1]} />
          <meshBasicMaterial transparent opacity={(showDebugCollision ?? showDebugHit) ? 0.25 : 0} color="#ff6600" depthWrite={false} side={THREE.DoubleSide} visible={true} />
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
export function VertexDot({ x, y, px, baseColor, featureId, entityId, vertexKey, isEditing = false, showDebugHit }: {
  x: number; y: number; px: number; baseColor: string
  featureId?: string; entityId?: string; vertexKey?: string
  isEditing?: boolean; showDebugHit?: boolean
}) {
  const hitRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  const vertId = featureId && entityId && vertexKey ? `vertex:${featureId}:${entityId}:${vertexKey}` : undefined

  // Store reads for display and collision hiding.
  const setHoveredVertex = useSketchEditorStore(s => s.setHoveredVertex)
  const constraintHovered = useSketchEditorStore(s =>
    entityId && vertexKey ? s.hoveredConstraintEntityIds.has(`${entityId}:${vertexKey}`) : false
  )
  const activeFeatureId = useSketchEditorStore(s => s.activeFeatureId)
  // REGRESSION PROTECTION: Hide collision geometry during vertex drag.
  // Must check featureId, entityId, AND vertexKey to handle all cases.
  // Also hide hit geometry from non-active sketches to prevent raycasting interference.
  // See: src/components/__tests__/dragging.test.ts (REGRESSION 2)
  const drag = useSketchEditorStore(s => s.drag)
  const selected = useSketchEditorStore(s => vertId ? s.normalSelection.has(vertId) : false)
  const isInactiveSketch = featureId && activeFeatureId && featureId !== activeFeatureId
  const isDraggedVertex = drag && drag.type === 'vertex' && drag.entityId === entityId && drag.featureId === featureId

  const snapKind = determineSnapKind()

  // Layer 3B: hover state and dynamic selection accumulation.
  const { hovered, onOver, onOut, markAsClicked } = useHoverAndDynamicSelection({
    id: vertId ?? '',
    hoverPayload: () => { if (vertId) setHoveredVertex(vertId, [x, y], snapKind) },
    clearHoverPayload: () => setHoveredVertex(null, null, null),
  })

  // Layer 4 — Tool Layer: dimension / fieldPick / select dispatch on click.
  // Guard: vertId/featureId may be absent for purely decorative vertex dots.
  const onClick = useToolClickDispatch({
    id: vertId ?? '', featureId: featureId ?? '', isEditing: isEditing && !!vertId && !!featureId,
    dimensionKind: 'vertex', fieldPickKind: 'point',
  })

  // Layer 4 — Tool Layer: vertex drag initiation via DragPlane.
  // startWorld is the vertex center [x, y], not the hit point, so snap offsets are computed correctly.
  // sanitizePointerEvent is not used here -- x, y are already sketch-local coordinates from props.
  // See: dragging.test.ts REGRESSION 4 and feature/feature_headless_viewport.md Step 5.
  const { initDrag } = useDragInitiation()
  const onPointerDown = useCallback((e: { stopPropagation: () => void; clientX: number; clientY: number }) => {
    if (!vertId || !featureId || !entityId || !vertexKey) return
    initDrag(e, { type: 'vertex', id: vertId, featureId, entityId, vertexKey, startWorld: [x, y], isEditing, markAsClicked })
  }, [vertId, featureId, entityId, vertexKey, isEditing, x, y, markAsClicked, initDrag])

  useFrame(() => {
    if (!hitRef.current) return
    hitRef.current.scale.setScalar(POINT_HIT_PIXELS * p2w(camera))
  })

  const color = hovered ? COLOR_HOVER : selected ? COLOR_SELECTED : constraintHovered ? COLOR_CONSTRAINT_HOVER : baseColor

  return (
    <group
      onPointerOver={onOver}
      onPointerOut={onOut}
      onClick={onClick}
      onPointerDown={onPointerDown}
    >
      <Dot x={x} y={y} px={hovered ? px + 2 : px} color={color} billboard />
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
 *  Clickable with the dimension tool; not draggable. */
export function ProjectedOriginPoint({ x, y, featureId, entityId }: { x: number; y: number; featureId: string; entityId: string }) {
  const groupRef = useRef<THREE.Group>(null)
  const hitRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  const entId = `entity:${featureId}:${entityId}`
  const activeFeatureId = useSketchEditorStore(s => s.activeFeatureId)
  const selected = useSketchEditorStore(s => s.normalSelection.has(entId))
  const constraintHovered = useSketchEditorStore(s => s.hoveredConstraintEntityIds.has(entityId))
  const setInternalHoverSelection = useSketchEditorStore(s => s.setInternalHoverSelection)

  // Layer 3B: hover state (no dynamic selection — projected points are not draggable).
  const { hovered, onOver, onOut } = useHoverAndDynamicSelection({
    id: entId,
    hoverPayload: () => setInternalHoverSelection(entId),
    clearHoverPayload: () => setInternalHoverSelection(null),
  })

  // Layer 4: dimension tool only for the active sketch's projected points.
  const isEditing = activeFeatureId === featureId
  const onClick = useToolClickDispatch({
    id: entId, featureId, isEditing, dimensionKind: 'entity', entityKind: 'point', fieldPickKind: 'line',
  })

  useFrame(() => {
    const scale = 7 * p2w(camera)
    if (groupRef.current) groupRef.current.scale.setScalar(scale)
    if (hitRef.current) hitRef.current.scale.setScalar(POINT_HIT_PIXELS * p2w(camera))
  })

  const color = hovered ? COLOR_HOVER : selected ? COLOR_SELECTED : constraintHovered ? COLOR_CONSTRAINT_HOVER : COLOR_PROJECTED
  return (
    <group ref={groupRef} position={[x, y, 0]}
      onPointerOver={onOver}
      onPointerOut={onOut}
      onClick={onClick}
    >
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
