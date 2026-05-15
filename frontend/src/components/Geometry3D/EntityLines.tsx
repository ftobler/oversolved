import { useCallback } from 'react'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import type { Sketch, Entity, LineSegment, Circle, Arc, PointEntity } from '@/types/cad'
import { isProjectedEntity } from '@/types/cad'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { sampleArc, sampleArcCCW, pointTo3D, allFinite } from '@/components/sketch_helpers'
import { DashedLine } from '@/components/sketch_dimensions'
import { VertexDot, HitPolyline, ProjectedOriginPoint } from '@/components/Geometry3D/VertexDots'
import { COLOR_HOVER, COLOR_SELECTED, COLOR_CONSTRAINT_HOVER, COLOR_PROJECTED, RENDER_ORDER_EDITING } from '@/components/Geometry3D/constants'
import { sanitizePointerEvent } from '@/components/Geometry3D/pointerAbstractionAdapters'
import { useHoverAndDynamicSelection } from '@/components/Geometry3D/useHoverAndDynamicSelection'
import { useToolClickDispatch } from '@/components/Geometry3D/useToolClickDispatch'
import { useDragInitiation } from '@/components/Geometry3D/useDragInitiation'

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
  const entId = `entity:${featureId}:${entityId}`

  // Store reads for selection display and collision hiding.
  const constraintHovered = useSketchEditorStore(s => s.hoveredConstraintEntityIds.has(entityId))
  const setInternalHoverSelection = useSketchEditorStore(s => s.setInternalHoverSelection)
  const activeFeatureId = useSketchEditorStore(s => s.activeFeatureId)
  const drag = useSketchEditorStore(s => s.drag)
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const pickChipHighlightItems = useSketchEditorStore(s => s.pickChipHighlightItems)
  // Highlight pathway: a sketch entity is "selected-looking" if it is in normalSelection
  // OR currently held by an active pick chip. User invariant (§Pick Chips):
  //   "Everything the pick chip contains must be highlighted."
  const selected = normalSelection.has(entId) || pickChipHighlightItems.includes(entId)

  // REGRESSION PROTECTION: Hide collision geometry during entity drag.
  // Must check both entityId and featureId to handle multiple sketches.
  // Also hide hit geometry from non-active sketches to prevent raycasting interference.
  // See: src/components/__tests__/dragging.test.ts (REGRESSION 2)
  const isInactiveSketch = activeFeatureId && featureId !== activeFeatureId
  const isDraggedEntity = drag && drag.type === 'edge' && drag.entityId === entityId && drag.featureId === featureId
  const isDraggedVertex = drag && drag.type === 'vertex' && drag.entityId === entityId && drag.featureId === featureId

  // Layer 3B: hover state and dynamic selection accumulation.
  const { hovered, onOver, onOut, markAsClicked } = useHoverAndDynamicSelection({
    id: entId,
    hoverPayload: () => setInternalHoverSelection(entId),
    clearHoverPayload: () => setInternalHoverSelection(null),
  })

  // Layer 4 — Tool Layer: dimension / fieldPick / select dispatch on click.
  const onClick = useToolClickDispatch({
    id: entId, isEditing, entityKind,
  })

  // Layer 4 — Tool Layer: edge drag initiation via DragPlane.
  // startWorld is the sanitized local hit point on the edge (not the entity origin).
  // startClient is screen pixels for click-vs-drag disambiguation. See: dragging.test.ts REGRESSION 4
  // We defer drag initiation to Dragging.tsx which checks if movement exceeds CLICK_THRESHOLD_PX.
  // Also sets isPointerDown=true to enable dynamic selection accumulation during mouse-down + hover.
  const { initDrag } = useDragInitiation()
  const onPointerDown = useCallback((ev: { stopPropagation: () => void; point: THREE.Vector3; clientX: number; clientY: number }) => {
    const sanitized = planeGroupRef ? sanitizePointerEvent(ev, planeGroupRef) : null
    const [sx, sy] = sanitized?.localPoint ?? [ev.point.x, ev.point.y]
    initDrag(ev, { type: 'edge', id: entId, featureId, entityId, vertexKey: 'edge', startWorld: [sx, sy], isEditing, markAsClicked })
  }, [isEditing, entId, featureId, entityId, planeGroupRef, markAsClicked, initDrag])

  const e = entity
  const construction = 'construction' in e && e.construction
  const color = hovered ? COLOR_HOVER : selected ? COLOR_SELECTED : constraintHovered ? COLOR_CONSTRAINT_HOVER : baseColor
  const lw = hovered ? lineWidth + 1 : lineWidth

  if ('start' in e && 'end' in e && 'radius' in e) {
    const arc = e as Arc
    if (!allFinite(arc.center[0], arc.center[1], arc.radius, arc.angle_start, arc.angle_end)) return null
    const pts = sampleArcCCW(arc.center[0], arc.center[1], arc.radius, arc.angle_start, arc.angle_end)
    return (
      <>
        {/* Collision volume must be the click/hover target — never use the thin visual line (Line/DashedLine)
         * for pointer events, as it provides inconsistent hit detection compared to hover. */}
        <group>
          {!isInactiveSketch && !isDraggedEntity && !isDraggedVertex && (
            <HitPolyline pts={pts} showDebugHit={showDebugHit}
              onClick={onClick} onPointerDown={onPointerDown} onPointerOver={onOver} onPointerOut={onOut} />
          )}
          {construction
            ? <DashedLine points={pts} color={color} lineWidth={lw} depthTest={isEditing ? false : undefined} renderOrder={isEditing ? RENDER_ORDER_EDITING : undefined} />
            : <Line points={pts} color={color} lineWidth={lw} depthTest={false} renderOrder={isEditing ? RENDER_ORDER_EDITING : undefined} />}
        </group>
        <VertexDot x={arc.start[0]} y={arc.start[1]} px={4} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="start"  isEditing={isEditing} showDebugHit={showDebugHit} />
        <VertexDot x={arc.end[0]} y={arc.end[1]} px={4} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="end"  isEditing={isEditing} showDebugHit={showDebugHit} />
        <VertexDot x={arc.center[0]} y={arc.center[1]} px={2.5} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="center"  isEditing={isEditing} showDebugHit={showDebugHit} />
      </>
    )
  } else if ('start' in e) {
    const line = e as LineSegment
    const start3 = pointTo3D(line.start)
    const end3 = pointTo3D(line.end)
    if (!start3 || !end3) return null
    const pts: [number, number, number][] = [start3, end3]
    return (
      <>
        <group>
          {!isInactiveSketch && !isDraggedEntity && !isDraggedVertex && (
            <HitPolyline pts={pts} showDebugHit={showDebugHit}
              onClick={onClick} onPointerDown={onPointerDown} onPointerOver={onOver} onPointerOut={onOut} />
          )}
          {construction
            ? <DashedLine points={pts} color={color} lineWidth={lw} depthTest={isEditing ? false : undefined} renderOrder={isEditing ? RENDER_ORDER_EDITING : undefined} />
            : <Line points={pts} color={color} lineWidth={lw} depthTest={false} renderOrder={isEditing ? RENDER_ORDER_EDITING : undefined} />}
        </group>
        <VertexDot x={line.start[0]} y={line.start[1]} px={4} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="start"  isEditing={isEditing} showDebugHit={showDebugHit} />
        <VertexDot x={line.end[0]} y={line.end[1]} px={4} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="end"  isEditing={isEditing} showDebugHit={showDebugHit} />
      </>
    )
  } else if ('x' in e) {
    const pt = e as PointEntity
    if (!allFinite(pt.x, pt.y)) return null
    return <VertexDot x={pt.x} y={pt.y} px={5} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="xy"  isEditing={isEditing} showDebugHit={showDebugHit} />
  } else {
    const circ = e as Circle
    if (!allFinite(circ.center[0], circ.center[1], circ.radius)) return null
    const pts = sampleArc(circ.center[0], circ.center[1], circ.radius, 0, 0)
    return (
      <>
        <group>
          {!isInactiveSketch && !isDraggedEntity && !isDraggedVertex && (
            <HitPolyline pts={pts} showDebugHit={showDebugHit}
              onClick={onClick} onPointerDown={onPointerDown} onPointerOver={onOver} onPointerOut={onOut} />
          )}
          {construction
            ? <DashedLine points={pts} color={color} lineWidth={lw} depthTest={isEditing ? false : undefined} renderOrder={isEditing ? RENDER_ORDER_EDITING : undefined} />
            : <Line points={pts} color={color} lineWidth={lw} depthTest={false} renderOrder={isEditing ? RENDER_ORDER_EDITING : undefined} />}
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
            return <Line key={id} points={pts} color={COLOR_PROJECTED} lineWidth={1} depthTest={false} />
          } else if ('start' in entity && 'end' in entity) {
            const line = entity as LineSegment
            const pts: [number, number, number][] = [[line.start[0], line.start[1], 0], [line.end[0], line.end[1], 0]]
            return <Line key={id} points={pts} color={COLOR_PROJECTED} lineWidth={1} depthTest={false} />
          } else if ('center' in entity) {
            const circ = entity as Circle
            const pts = sampleArc(circ.center[0], circ.center[1], circ.radius, 0, 0)
            return <Line key={id} points={pts} color={COLOR_PROJECTED} lineWidth={1} depthTest={false} />
          } else {
            const pt = entity as PointEntity
            return <ProjectedOriginPoint key={id} x={pt.x} y={pt.y} featureId={featureId} entityId={id} />
          }
        })}
    </>
  )
}


