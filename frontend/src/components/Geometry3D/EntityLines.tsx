import { useState, useCallback, useRef } from 'react'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import type { Sketch, Entity, LineSegment, Circle, Arc, PointEntity } from '../../types/cad'
import { isProjectedEntity } from '../../types/cad'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { sampleArc, sampleArcCCW, getEntityBounds } from '../sketch_helpers'
import { DashedLine } from '../sketch_dimensions'
import { VertexDot, HitPolyline, ProjectedOriginPoint } from './VertexDots'
import { COLOR_HOVER, COLOR_SELECTED, COLOR_CONSTRAINT_HOVER, COLOR_PROJECTED } from './constants'

interface EntityItemProps {
  entity: Entity
  entityId: string
  entityKind: string
  featureId: string
  baseColor: string
  lineWidth?: number
  isEditing?: boolean
  planeGroupRef?: React.RefObject<THREE.Group | null>
  showDebugHit?: boolean
}

export function EntityItem({ entity, entityId, entityKind, featureId, baseColor, lineWidth = 1, isEditing = false, planeGroupRef, showDebugHit }: EntityItemProps) {
  // HOVER PATTERN: Local state for visual feedback (fast), store for logic/debug.
  // DO NOT use local hovered state alone - must also call setHoveredEntity().
  const [hovered, setHovered] = useState(false)
  const entId = `entity:${featureId}:${entityId}`
  const selected = useSketchEditorStore(s => s.selection.has(entId))
  const constraintHovered = useSketchEditorStore(s => s.hoveredConstraintEntityIds.has(entityId))
  const toggleSelect = useSketchEditorStore(s => s.toggleSelect)
  const setDrag = useSketchEditorStore(s => s.setDrag)
  const setOrbitEnabled = useSketchEditorStore(s => s.setOrbitEnabled)
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const handleDimClick = useSketchEditorStore(s => s.handleDimensionClick)
  const setHoveredEntity = useSketchEditorStore(s => s.setHoveredEntity)
  const fieldPickState = useSketchEditorStore(s => s.fieldPickState)
  const commitFieldPick = useSketchEditorStore(s => s.commitFieldPick)
  // REGRESSION PROTECTION: Hide collision geometry during entity drag
  // BUG: When dragging, DragPlane raycasts could be blocked by the entity's own
  //      HitPolyline collision geometry, causing choppy/stalled dragging.
  // FIX: Hide collision immediately when drag starts (not just after movement begins).
  // NOTE: Must check both entityId and featureId to handle multiple sketches.
  // Also hide hit geometry from non-active sketches to prevent raycasting interference.
  // See: src/components/__tests__/dragging.test.ts (REGRESSION 2)
  const activeFeatureId = useSketchEditorStore(s => s.activeFeatureId)
  const drag = useSketchEditorStore(s => s.drag)
  const isInactiveSketch = activeFeatureId && featureId !== activeFeatureId
  const isDraggedEntity = drag && drag.type === 'edge' && drag.entityId === entityId && drag.featureId === featureId
  const isDraggedVertex = drag && drag.type === 'vertex' && drag.entityId === entityId && drag.featureId === featureId
  const color = hovered ? COLOR_HOVER
    : selected ? COLOR_SELECTED
    : constraintHovered ? COLOR_CONSTRAINT_HOVER
    : baseColor
  const lw = hovered ? lineWidth + 1 : lineWidth
  const e = entity
  const construction = 'construction' in e && e.construction
  const isDrawingTool = activeTool !== 'select' && activeTool !== 'dimension'
  const isRotating = useSketchEditorStore(s => s.isRotating)
  const setIsPointerDown = useSketchEditorStore(s => s.setIsPointerDown)
  const toggleDynamicSelection = useSketchEditorStore(s => s.toggleDynamicSelection)
  const isPointerDown = useSketchEditorStore(s => s.isPointerDown)
  const lastHoveredRef = useRef<string | null>(null)
  // Ref to track entity that was clicked - prevents it from being added to dynamic selection
  const clickedEntityRef = useRef<string | null>(null)

  const onOver = (ev: { stopPropagation: () => void }) => {
    if (isRotating) return
    if (!isDrawingTool) ev.stopPropagation()
    // Don't set hovered state if already selected - keep selected color
    if (!selected) setHovered(true)
    setHoveredEntity(entId)

    // Dynamic selection: add to set if pointer is down and not already processed
    // Exclude the entity that was clicked (drag initiator) to avoid self-referencing
    // Also exclude already-selected elements
    if (isPointerDown && !selected && lastHoveredRef.current !== entId && clickedEntityRef.current !== entId) {
      lastHoveredRef.current = entId
      toggleDynamicSelection(entId)
    }
  }
  const onOut = () => {
    if (isRotating) return
    lastHoveredRef.current = null
    // Clear click initiator when leaving the entity
    if (clickedEntityRef.current === entId) {
      clickedEntityRef.current = null
    }
    setHovered(false)
    setHoveredEntity(null)
  }
  const onClick = useCallback((ev: { stopPropagation: () => void; clientX: number; clientY: number }) => {
    ev.stopPropagation()
    if (activeTool === 'dimension') {
      if (!isEditing) return
      handleDimClick(`entity:${featureId}:${entityId}`, featureId, 'entity', [ev.clientX, ev.clientY], entityKind)
    } else if (fieldPickState?.kind === 'line') {
      commitFieldPick(entId)
    } else {
      toggleSelect(entId)
    }
  }, [entId, toggleSelect, activeTool, handleDimClick, featureId, entityId, entityKind, isEditing, fieldPickState, commitFieldPick])
  // Convert world coordinates to sketch-local coordinates by applying inverse of plane group transform
  const toLocal = useCallback((worldPt: { x: number; y: number; z?: number }): [number, number] => {
    const ref = planeGroupRef?.current
    if (!ref) return [worldPt.x, worldPt.y]
    const parentPos = new THREE.Vector3()
    ref.getWorldPosition(parentPos)
    const q = new THREE.Quaternion()
    ref.getWorldQuaternion(q)
    const worldVec = new THREE.Vector3(worldPt.x, worldPt.y, worldPt.z ?? 0)
    const local = worldVec.clone().sub(parentPos).applyQuaternion(q.invert())
    return [local.x, local.y]
  }, [planeGroupRef])

  // Edge drag: pointer down on the edge group initiates a full-entity move
  const onPointerDown = useCallback((ev: { stopPropagation: () => void; point: { x: number; y: number; z?: number }; clientX: number; clientY: number }) => {
    if (!isEditing || activeTool !== 'select') return
    ev.stopPropagation()
    setOrbitEnabled(false)

    // Mark this entity as the click initiator - prevents it from being added to dynamic selection
    clickedEntityRef.current = entId

    // Dynamic selection: track pointer down state
    setIsPointerDown(true)

    const [sx, sy] = toLocal(ev.point)
    // startClient is screen pixel coordinates at pointer-down; used to distinguish clicks from drags.
    // See: dragging.test.ts REGRESSION 4
    setDrag({ type: 'edge', vertexId: entId, featureId, entityId,
      vertexKey: 'edge', startWorld: [sx, sy], currentWorld: [sx, sy], startClient: [ev.clientX, ev.clientY] })
  }, [isEditing, entId, featureId, entityId, setDrag, setOrbitEnabled, activeTool, toLocal, setIsPointerDown])

  if ('start' in e && 'end' in e && 'radius' in e) {
    const arc = e as Arc
    const pts = sampleArcCCW(arc.center[0], arc.center[1], arc.radius, arc.angle_start, arc.angle_end)
    return (
      <>
        <group onClick={onClick} onPointerDown={onPointerDown}>
          {!isInactiveSketch && !isDraggedEntity && !isDraggedVertex && <HitPolyline pts={pts} onPointerOver={onOver} onPointerOut={onOut} showDebugHit={showDebugHit} />}
          {construction
            ? <DashedLine points={pts} color={color} lineWidth={lw} />
            : <Line points={pts} color={color} lineWidth={lw} />}
        </group>
        <VertexDot x={arc.start[0]} y={arc.start[1]} px={4} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="start"  isEditing={isEditing} showDebugHit={showDebugHit} />
        <VertexDot x={arc.end[0]} y={arc.end[1]} px={4} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="end"  isEditing={isEditing} showDebugHit={showDebugHit} />
        <VertexDot x={arc.center[0]} y={arc.center[1]} px={2.5} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="center"  isEditing={isEditing} showDebugHit={showDebugHit} />
      </>
    )
  } else if ('start' in e) {
    const line = e as LineSegment
    const pts: [number, number, number][] = [[line.start[0], line.start[1], 0], [line.end[0], line.end[1], 0]]
    return (
      <>
        <group onClick={onClick} onPointerDown={onPointerDown}>
          {!isInactiveSketch && !isDraggedEntity && !isDraggedVertex && <HitPolyline pts={pts} onPointerOver={onOver} onPointerOut={onOut} showDebugHit={showDebugHit} />}
          {construction
            ? <DashedLine points={pts} color={color} lineWidth={lw} />
            : <Line points={pts} color={color} lineWidth={lw} />}
        </group>
        <VertexDot x={line.start[0]} y={line.start[1]} px={4} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="start"  isEditing={isEditing} showDebugHit={showDebugHit} />
        <VertexDot x={line.end[0]} y={line.end[1]} px={4} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="end"  isEditing={isEditing} showDebugHit={showDebugHit} />
      </>
    )
  } else if ('x' in e) {
    const pt = e as PointEntity
    return <VertexDot x={pt.x} y={pt.y} px={5} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="xy"  isEditing={isEditing} showDebugHit={showDebugHit} />
  } else {
    const circ = e as Circle
    const pts = sampleArc(circ.center[0], circ.center[1], circ.radius, 0, 0)
    return (
      <>
        <group onClick={onClick} onPointerDown={onPointerDown}>
          {!isInactiveSketch && !isDraggedEntity && !isDraggedVertex && <HitPolyline pts={pts} onPointerOver={onOver} onPointerOut={onOut} showDebugHit={showDebugHit} />}
          {construction
            ? <DashedLine points={pts} color={color} lineWidth={lw} />
            : <Line points={pts} color={color} lineWidth={lw} />}
        </group>
        <VertexDot x={circ.center[0]} y={circ.center[1]} px={2.5} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="center"  isEditing={isEditing} showDebugHit={showDebugHit} />
      </>
    )
  }
}

interface EntityLinesProps {
  sketch: Sketch
  featureId: string
  color: string | ((entityId: string) => string)
  kindMap: Record<string, string>
  lineWidth?: number
  isEditing?: boolean
  planeGroupRef?: React.RefObject<THREE.Group | null>
  showDebugHit?: boolean
}

export function EntityLines({ sketch, featureId, color, kindMap, lineWidth = 1, isEditing = false, planeGroupRef, showDebugHit }: EntityLinesProps) {
  const getColor = typeof color === 'function' ? color : () => color
  return (
    <>
      {Object.entries(sketch)
        .filter(([, entity]) => !(entity as PointEntity).projected)
        .map(([id, entity]) => (
          <EntityItem key={id} entity={entity as Entity} entityId={id} entityKind={kindMap[id] ?? 'line'} featureId={featureId} baseColor={getColor(id)} lineWidth={lineWidth} isEditing={isEditing} planeGroupRef={planeGroupRef} showDebugHit={showDebugHit} />
        ))}
    </>
  )
}

// Renders all projected entities in the sketch (those with projected: true) in amber.
export function ProjectedEntities({ sketch, featureId }: { sketch: Sketch; featureId: string }) {
  return (
    <>
      {Object.entries(sketch)
        .filter(([id, e]) => isProjectedEntity(e as Entity) && id !== '_origin')
        .map(([id, e]) => {
          const entity = e as Entity
          if ('start' in entity && 'end' in entity && 'radius' in entity) {
            const arc = entity as Arc
            const pts = sampleArcCCW(arc.center[0], arc.center[1], arc.radius, arc.angle_start, arc.angle_end)
            return <Line key={id} points={pts} color={COLOR_PROJECTED} lineWidth={1} />
          } else if ('start' in entity && 'end' in entity) {
            const line = entity as LineSegment
            const pts: [number, number, number][] = [[line.start[0], line.start[1], 0], [line.end[0], line.end[1], 0]]
            return <Line key={id} points={pts} color={COLOR_PROJECTED} lineWidth={1} />
          } else if ('center' in entity) {
            const circ = entity as Circle
            const pts = sampleArc(circ.center[0], circ.center[1], circ.radius, 0, 0)
            return <Line key={id} points={pts} color={COLOR_PROJECTED} lineWidth={1} />
          } else {
            const pt = entity as PointEntity
            return <ProjectedOriginPoint key={id} x={pt.x} y={pt.y} featureId={featureId} entityId={id} />
          }
        })}
    </>
  )
}

// Calculate the bounding box extent of a sketch.
// eslint-disable-next-line react-refresh/only-export-components
export function sketchExtent(sketch: Sketch): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const entity of Object.values(sketch)) {
    const b = getEntityBounds(entity as Entity)
    minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX)
    minY = Math.min(minY, b.minY); maxY = Math.max(maxY, b.maxY)
  }
  return isFinite(minX) ? Math.max(maxX - minX, maxY - minY, 0.01) : 1
}

// Find all entity IDs in the sketch that have a vertex at the given point (within eps).
// eslint-disable-next-line react-refresh/only-export-components
export function findEntitiesAtPoint(sketch: Sketch, pt: [number, number], eps = 1e-4): string[] {
  const [px, py] = pt
  const near = (x: number, y: number) => Math.abs(x - px) <= eps && Math.abs(y - py) <= eps
  const ids: string[] = []
  for (const [eid, entity] of Object.entries(sketch)) {
    const e = entity as Entity
    if ('start' in e && 'end' in e) {
      if (near(e.start[0], e.start[1]) || near(e.end[0], e.end[1])) ids.push(eid)
    } else if ('x' in e) {
      if (near(e.x, e.y)) ids.push(eid)
    } else if ('center' in e) {
      if (near(e.center[0], e.center[1])) ids.push(eid)
    }
  }
  return ids
}
