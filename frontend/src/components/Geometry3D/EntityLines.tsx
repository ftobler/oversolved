import { useState, useCallback } from 'react'
import { Line } from '@react-three/drei'
import type { Sketch, Entity, LineSegment, Circle, Arc, PointEntity } from '../../types/cad'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { sampleArc, sampleArcCCW, getEntityBounds } from '../sketch_helpers'
import { DashedLine } from '../sketch_dimensions'
import { VertexDot, HitPolyline, ProjectedOriginPoint } from './VertexDots'
import { COLOR_HOVER, COLOR_SELECTED, COLOR_CONSTRAINT_HOVER } from './constants'

interface EntityItemProps {
  entity: Entity
  entityId: string
  entityKind: string
  featureId: string
  baseColor: string
  lineWidth?: number
  isEditing?: boolean
}

export function EntityItem({ entity, entityId, entityKind, featureId, baseColor, lineWidth = 1, isEditing = false }: EntityItemProps) {
  const [hovered, setHovered] = useState(false)
  const entId = `entity:${featureId}:${entityId}`
  const selected = useSketchEditorStore(s => s.selection.has(entId))
  const constraintHovered = useSketchEditorStore(s => s.hoveredConstraintEntityIds.has(entityId))
  const toggleSelect = useSketchEditorStore(s => s.toggleSelect)
  const setDrag = useSketchEditorStore(s => s.setDrag)
  const setOrbitEnabled = useSketchEditorStore(s => s.setOrbitEnabled)
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const handleDimClick = useSketchEditorStore(s => s.handleDimensionClick)
  const drag = useSketchEditorStore(s => s.drag)
  // Hide collision geometry while this entity is being dragged to prevent self-intersection
  // blocking raycasts on the DragPlane. This allows smooth dragging even when the
  // dragged entity overlaps its own collision mesh.
  const isDragged = drag && 'entityId' in drag && drag.entityId === entityId && drag.featureId === featureId
  const color = hovered ? COLOR_HOVER
    : selected ? COLOR_SELECTED
    : constraintHovered ? COLOR_CONSTRAINT_HOVER
    : baseColor
  const lw = hovered ? lineWidth + 1 : lineWidth
  const e = entity
  const construction = 'construction' in e && e.construction
  const isDrawingTool = activeTool !== 'select' && activeTool !== 'dimension'
  const onOver = (ev: { stopPropagation: () => void }) => { if (!isDrawingTool) ev.stopPropagation(); setHovered(true) }
  const onOut = () => setHovered(false)
  const onClick = useCallback((ev: { stopPropagation: () => void; clientX: number; clientY: number }) => {
    ev.stopPropagation()
    if (activeTool === 'dimension') {
      if (!isEditing) return
      handleDimClick(`entity:${featureId}:${entityId}`, featureId, 'entity', [ev.clientX, ev.clientY], entityKind)
    } else {
      toggleSelect(entId)
    }
  }, [entId, toggleSelect, activeTool, handleDimClick, featureId, entityId, entityKind, isEditing])
  // Edge drag: pointer down on the edge group initiates a full-entity move
  const onPointerDown = useCallback((ev: { stopPropagation: () => void; point: { x: number; y: number } }) => {
    if (!isEditing || activeTool !== 'select') return
    ev.stopPropagation()
    setOrbitEnabled(false)
    setDrag({ type: 'edge', vertexId: entId, featureId, entityId,
      vertexKey: 'edge', startWorld: [ev.point.x, ev.point.y], currentWorld: [ev.point.x, ev.point.y] })
  }, [isEditing, entId, featureId, entityId, setDrag, setOrbitEnabled, activeTool])

  if ('start' in e && 'end' in e && 'radius' in e) {
    const arc = e as Arc
    const pts = sampleArcCCW(arc.center[0], arc.center[1], arc.radius, arc.angle_start, arc.angle_end)
    return (
      <>
        <group onClick={onClick} onPointerDown={onPointerDown}>
          {!isDragged && <HitPolyline pts={pts} onPointerOver={onOver} onPointerOut={onOut} />}
          {construction
            ? <DashedLine points={pts} color={color} lineWidth={lw} />
            : <Line points={pts} color={color} lineWidth={lw} />}
        </group>
        <VertexDot x={arc.start[0]} y={arc.start[1]} px={4} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="start" isEditing={isEditing} />
        <VertexDot x={arc.end[0]} y={arc.end[1]} px={4} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="end" isEditing={isEditing} />
        <VertexDot x={arc.center[0]} y={arc.center[1]} px={2.5} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="center" isEditing={isEditing} />
      </>
    )
  } else if ('start' in e) {
    const line = e as LineSegment
    const pts: [number, number, number][] = [[line.start[0], line.start[1], 0], [line.end[0], line.end[1], 0]]
    return (
      <>
        <group onClick={onClick} onPointerDown={onPointerDown}>
          {!isDragged && <HitPolyline pts={pts} onPointerOver={onOver} onPointerOut={onOut} />}
          {construction
            ? <DashedLine points={pts} color={color} lineWidth={lw} />
            : <Line points={pts} color={color} lineWidth={lw} />}
        </group>
        <VertexDot x={line.start[0]} y={line.start[1]} px={4} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="start" isEditing={isEditing} />
        <VertexDot x={line.end[0]} y={line.end[1]} px={4} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="end" isEditing={isEditing} />
      </>
    )
  } else if ('x' in e) {
    const pt = e as PointEntity
    return <VertexDot x={pt.x} y={pt.y} px={5} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="xy" isEditing={isEditing} />
  } else {
    const circ = e as Circle
    const pts = sampleArc(circ.center[0], circ.center[1], circ.radius, 0, 0)
    return (
      <>
        <group onClick={onClick} onPointerDown={onPointerDown}>
          {!isDragged && <HitPolyline pts={pts} onPointerOver={onOver} onPointerOut={onOut} />}
          {construction
            ? <DashedLine points={pts} color={color} lineWidth={lw} />
            : <Line points={pts} color={color} lineWidth={lw} />}
        </group>
        <VertexDot x={circ.center[0]} y={circ.center[1]} px={2.5} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="center" isEditing={isEditing} />
      </>
    )
  }
}

interface EntityLinesProps {
  sketch: Sketch
  featureId: string
  color: string
  kindMap: Record<string, string>
  lineWidth?: number
  isEditing?: boolean
}

export function EntityLines({ sketch, featureId, color, kindMap, lineWidth = 1, isEditing = false }: EntityLinesProps) {
  return (
    <>
      {Object.entries(sketch)
        .filter(([, entity]) => !(entity as PointEntity).projected)
        .map(([id, entity]) => (
          <EntityItem key={id} entity={entity as Entity} entityId={id} entityKind={kindMap[id] ?? 'line'} featureId={featureId} baseColor={color} lineWidth={lineWidth} isEditing={isEditing} />
        ))}
    </>
  )
}

/** Renders all projected entities in the sketch (those with projected: true). */
export function ProjectedEntities({ sketch, featureId }: { sketch: Sketch; featureId: string }) {
  return (
    <>
      {Object.entries(sketch)
        .filter(([id, e]) => (e as PointEntity).projected && id !== '_origin')
        .map(([id, e]) => {
          const pt = e as PointEntity
          return <ProjectedOriginPoint key={id} x={pt.x} y={pt.y} featureId={featureId} entityId={id} />
        })}
    </>
  )
}

/** Calculate the bounding box extent of a sketch. */
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

/** Find all entity IDs in the sketch that have a vertex at the given point (within eps). */
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
