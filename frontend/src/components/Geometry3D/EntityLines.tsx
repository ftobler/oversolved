import { Line } from '@react-three/drei'
import type { Sketch, Entity, LineSegment, Circle, Arc, PointEntity } from '@/types/cad'
import { isProjectedEntity } from '@/types/cad'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { sampleArc, sampleArcCCW, pointTo3D, allFinite } from '@/components/sketch/sketch_helpers'
import { DashedLine } from '@/components/sketch/sketch_dimensions'
import { VertexDot, ProjectedOriginPoint } from '@/components/Geometry3D/VertexDots'
import { COLOR_HOVER, COLOR_SELECTED, COLOR_CONSTRAINT_HOVER, COLOR_PROJECTED, COLOR_INACTIVE, RENDER_ORDER_EDITING } from '@/components/Geometry3D/constants'

interface EntityItemProps {
  entity: Entity
  entityId: string
  entityKind?: string
  featureId: string
  baseColor: string
  lineWidth?: number
  isEditing?: boolean
}

export function EntityItem({ entity, entityId, featureId, baseColor, lineWidth = 1, isEditing = false }: EntityItemProps) {
  const entId = `entity:${featureId}:${entityId}`

  // Store reads for selection display and hover.
  const constraintHovered = useSketchEditorStore(s => s.hoveredConstraintEntityIds.has(entityId))
  const hoveredSelectionId = useSketchEditorStore(s => s.hoveredSelectionId)
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const selected = normalSelection.has(entId)

  // Hover state is driven by the ID-buffer dispatcher.
  const hovered = hoveredSelectionId === entId

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
      {/* Picking is handled by the ID buffer (267.5). */}
      <group>
        {construction
            ? <DashedLine points={pts} color={color} lineWidth={lw} depthTest={(isEditing || selected) ? false : undefined} renderOrder={(isEditing || selected) ? RENDER_ORDER_EDITING : undefined} />
            : <Line points={pts} color={color} lineWidth={lw} depthTest={(isEditing || selected) ? false : undefined} renderOrder={(isEditing || selected) ? RENDER_ORDER_EDITING : undefined} />}
        </group>
        <VertexDot x={arc.start[0]} y={arc.start[1]} px={4} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="start"  isEditing={isEditing} />
        <VertexDot x={arc.end[0]} y={arc.end[1]} px={4} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="end"  isEditing={isEditing} />
        <VertexDot x={arc.center[0]} y={arc.center[1]} px={2.5} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="center"  isEditing={isEditing} />
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

          {construction
            ? <DashedLine points={pts} color={color} lineWidth={lw} depthTest={(isEditing || selected) ? false : undefined} renderOrder={(isEditing || selected) ? RENDER_ORDER_EDITING : undefined} />
            : <Line points={pts} color={color} lineWidth={lw} depthTest={(isEditing || selected) ? false : undefined} renderOrder={(isEditing || selected) ? RENDER_ORDER_EDITING : undefined} />}
        </group>
        <VertexDot x={line.start[0]} y={line.start[1]} px={4} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="start"  isEditing={isEditing} />
        <VertexDot x={line.end[0]} y={line.end[1]} px={4} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="end"  isEditing={isEditing} />
      </>
    )
  } else if ('x' in e) {
    const pt = e as PointEntity
    if (!allFinite(pt.x, pt.y)) return null
    return <VertexDot x={pt.x} y={pt.y} px={5} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="xy"  isEditing={isEditing} />
  } else {
    const circ = e as Circle
    if (!allFinite(circ.center[0], circ.center[1], circ.radius)) return null
    const pts = sampleArc(circ.center[0], circ.center[1], circ.radius, 0, 0)
    return (
      <>
        <group>

          {construction
            ? <DashedLine points={pts} color={color} lineWidth={lw} depthTest={(isEditing || selected) ? false : undefined} renderOrder={(isEditing || selected) ? RENDER_ORDER_EDITING : undefined} />
            : <Line points={pts} color={color} lineWidth={lw} depthTest={(isEditing || selected) ? false : undefined} renderOrder={(isEditing || selected) ? RENDER_ORDER_EDITING : undefined} />}
        </group>
        <VertexDot x={circ.center[0]} y={circ.center[1]} px={2.5} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="center"  isEditing={isEditing} />
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
}

export function EntityLines({ sketch, featureId, color, kindMap, lineWidth = 1, isEditing = false }: EntityLinesProps) {
  const getColor = typeof color === 'function' ? color : () => color
  return (
    <>
      {Object.entries(sketch)
        .filter(([, entity]) => !(entity as PointEntity).projected)
        .map(([id, entity]) => (
          <EntityItem key={id} entity={entity as Entity} entityId={id} entityKind={kindMap[id] ?? 'line'} featureId={featureId} baseColor={getColor(id)} lineWidth={lineWidth} isEditing={isEditing} />
        ))}
    </>
  )
}

// Renders all projected entities in the sketch (those with projected: true).
// Amber while the sketch is being edited; grey (COLOR_INACTIVE) otherwise, so
// projected geometry matches the rest of the sketch. renderOrder mirrors the
// active sketch lines (RENDER_ORDER_EDITING) so it shares the same z-index.
export function ProjectedEntities({ sketch, featureId, isEditing = false }: { sketch: Sketch; featureId: string; isEditing?: boolean }) {
  const color = isEditing ? COLOR_PROJECTED : COLOR_INACTIVE
  const renderOrder = isEditing ? RENDER_ORDER_EDITING : undefined
  // While editing, draw on top (depthTest off). When only visible, depth-test
  // normally so the sketch sits at its plane like the rest of the sketch/area.
  const depthTest = isEditing ? false : undefined
  return (
    <>
      {Object.entries(sketch)
        .filter(([id, e]) => isProjectedEntity(e as Entity) && id !== '_origin')
        .map(([id, e]) => {
          const entity = e as Entity
          if ('start' in entity && 'end' in entity && 'radius' in entity) {
            const arc = entity as Arc
            const pts = sampleArcCCW(arc.center[0], arc.center[1], arc.radius, arc.angle_start, arc.angle_end)
            return <Line key={id} points={pts} color={color} lineWidth={1} depthTest={depthTest} renderOrder={renderOrder} />
          } else if ('start' in entity && 'end' in entity) {
            const line = entity as LineSegment
            const pts: [number, number, number][] = [[line.start[0], line.start[1], 0], [line.end[0], line.end[1], 0]]
            return <Line key={id} points={pts} color={color} lineWidth={1} depthTest={depthTest} renderOrder={renderOrder} />
          } else if ('center' in entity) {
            const circ = entity as Circle
            const pts = sampleArc(circ.center[0], circ.center[1], circ.radius, 0, 0)
            return <Line key={id} points={pts} color={color} lineWidth={1} depthTest={depthTest} renderOrder={renderOrder} />
          } else {
            const pt = entity as PointEntity
            return <ProjectedOriginPoint key={id} x={pt.x} y={pt.y} featureId={featureId} entityId={id} isEditing={isEditing} />
          }
        })}
    </>
  )
}

