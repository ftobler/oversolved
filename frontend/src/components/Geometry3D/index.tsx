import { useMemo } from 'react'
import type { Sketch, Constraints, Topology, PlaneTransform } from '../../types/cad'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'

// Vertex/point rendering
import { VertexDot, HitPolyline, VertexHighlight, ProjectedOriginPoint } from './VertexDots'

// Entity geometry rendering
import { EntityLines, ProjectedEntities, sketchExtent } from './EntityLines'

// Constraint display
import { ConstraintOverlays } from './Constraints'

// Topology surface rendering
import { TopologySurfaces } from './Surfaces'

// Dragging
import { DragPlane, applyDragPreview } from './Dragging'

// Drawing tools
import { DrawPreview, DrawPlane } from './Drawing'

// Utilities
import { planeRotation, planeRotationFromTransform } from './utils'

// Colors
import { COLOR_SOLVED, COLOR_ERROR, COLOR_INACTIVE } from './constants'

export interface Geometry3DProps {
  featureId: string
  solved: Sketch
  entities?: Array<{ id: string; kind: string }>
  constraints?: Constraints
  topology?: Topology
  activeFeatureId?: string
  plane?: string
  planeTransform?: PlaneTransform
  solveStatus?: string
}

export default function Geometry3D({ featureId, solved, entities, constraints, topology, activeFeatureId, plane, planeTransform, solveStatus }: Geometry3DProps) {
  const drag = useSketchEditorStore(s => s.drag)

  // During drag on this feature, show optimistic preview
  const displaySketch = useMemo(() => {
    if (drag && drag.featureId === featureId) return applyDragPreview(solved, drag)
    return solved
  }, [solved, drag, featureId])

  const extent = useMemo(() => sketchExtent(displaySketch), [displaySketch])
  const rot = planeTransform ? planeRotationFromTransform(planeTransform) : planeRotation(plane)
  const kindMap = useMemo(() =>
    Object.fromEntries((entities ?? []).map(e => [e.id, e.kind])),
    [entities]
  )

  const isEditing = featureId === activeFeatureId
  const baseColor = isEditing
    ? ((solveStatus === 'overconstrained' || solveStatus === 'exception') ? COLOR_ERROR : COLOR_SOLVED)
    : COLOR_INACTIVE

  return (
    <group rotation={rot}>
      {topology && <TopologySurfaces topology={topology} featureId={featureId} isEditing={isEditing} activeFeatureId={activeFeatureId} />}
      <EntityLines sketch={displaySketch} featureId={featureId} color={baseColor} lineWidth={2} kindMap={kindMap} isEditing={isEditing} />
      <ProjectedEntities sketch={displaySketch} featureId={featureId} />
      {constraints && <ConstraintOverlays constraints={constraints} sketch={displaySketch} extent={extent} featureId={featureId} isEditing={isEditing} />}
      <DragPlane featureId={featureId} />
      <DrawPreview featureId={featureId} activeFeatureId={activeFeatureId} />
      <DrawPlane featureId={featureId} activeFeatureId={activeFeatureId} />
    </group>
  )
}

// Re-export components for external use if needed
export { VertexDot, HitPolyline, VertexHighlight, ProjectedOriginPoint }
// eslint-disable-next-line react-refresh/only-export-components
export { EntityLines, ProjectedEntities, sketchExtent }
export { ConstraintOverlays }
export { TopologySurfaces }
// eslint-disable-next-line react-refresh/only-export-components
export { DragPlane, applyDragPreview }
export { DrawPreview, DrawPlane }
