import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { Sketch, Constraints, Topology, PlaneTransform, EntityStatus } from '@/types/cad'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

// Vertex/point rendering
import { VertexDot, HitPolyline, VertexHighlight, ProjectedOriginPoint } from '@/components/Geometry3D/VertexDots'

// Entity geometry rendering
import { EntityLines, ProjectedEntities } from '@/components/Geometry3D/EntityLines'
import { sketchExtent } from '@/components/Geometry3D/drawGeometry'

// Constraint display
import { ConstraintOverlays } from '@/components/Geometry3D/Constraints'

// Topology surface rendering
import { TopologySurfaces, TopologyEdges } from '@/components/Geometry3D/Surfaces'

// Dragging
import { DragPlane, DragSnapIndicator, DragAlignmentIndicator } from '@/components/Geometry3D/Dragging'
import { applyDragPreview } from '@/components/Geometry3D/dragLogic'

// Drawing tools
import { DrawPreview, DrawPlane } from '@/components/Geometry3D/Drawing'

// Utilities
import { planeRotation, planeRotationFromTransform } from '@/components/Geometry3D/utils'

// Colors
import { COLOR_SOLVED, COLOR_FULLY_CONSTRAINED, COLOR_ERROR, COLOR_INACTIVE } from '@/components/Geometry3D/constants'

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
  entityStatus?: EntityStatus
  showDebugHit?: boolean
  otherSketches?: Record<string, Sketch>
}

export default function Geometry3D({ featureId, solved, entities, constraints, topology, activeFeatureId, plane, planeTransform, solveStatus, entityStatus, showDebugHit, otherSketches }: Geometry3DProps) {
  const groupRef = useRef<THREE.Group>(null)
  const drag = useSketchEditorStore(s => s.drag)

  // During drag on this feature, show optimistic preview
  const displaySketch = useMemo(() => {
    if (drag && drag.featureId === featureId) return applyDragPreview(solved, drag)
    return solved
  }, [solved, drag, featureId])

  const extent = useMemo(() => sketchExtent(displaySketch), [displaySketch])
  const rot = planeTransform ? planeRotationFromTransform(planeTransform) : planeRotation(plane)
  const pos = planeTransform?.origin as [number, number, number] | undefined
  const kindMap = useMemo(() =>
    Object.fromEntries((entities ?? []).map(e => [e.id, e.kind])),
    [entities]
  )

  const isEditing = featureId === activeFeatureId

  const getEntityColor = (entityId: string): string => {
    if (!isEditing) return COLOR_INACTIVE
    if (entityStatus && entityStatus[entityId]) {
      const status = entityStatus[entityId]
      return status === 'fully_constrained' ? COLOR_FULLY_CONSTRAINED
        : status === 'overconstrained' ? COLOR_ERROR
        : COLOR_SOLVED
    }
    // Fallback to sketch-level status
    return solveStatus === 'fully_constrained' ? COLOR_FULLY_CONSTRAINED
      : (solveStatus === 'overconstrained' || solveStatus === 'exception') ? COLOR_ERROR
      : solveStatus === 'underconstrained' ? COLOR_SOLVED
      : COLOR_INACTIVE
  }

  const baseColor = isEditing
    ? (solveStatus === 'fully_constrained' ? COLOR_FULLY_CONSTRAINED
      : (solveStatus === 'overconstrained' || solveStatus === 'exception') ? COLOR_ERROR
      : COLOR_SOLVED)
    : COLOR_INACTIVE

  // POINTER EVENT PRIORITY STACK (highest to lowest, enforced by Three.js raycast z-depth):
  //   1. Vertex hit spheres      (z=0, sphere geometry wins at endpoints)
  //   2. Entity HitPolylines     (z=-0.001)
  //   3. Sketch topology surfaces (z=-0.003 in sketch-plane space, wins over coplanar B-rep faces)
  //   4. DragPlane mesh          (z=0, mounted only when drag != null - owns all move/up events during drag)
  //   5. DrawPlane mesh          (z=-0.002, mounted only when activeTool is a drawing tool)
  //   6. B-rep faces/edges       (always interactive; topology surface z-offset gives sketch priority)
  //   7. Deselect plane          (z=-1000, catch-all for click-on-empty)
  //   8. OrbitControls           (canvas div level, suppressed via orbitEnabled=false during drag)
  //
  // New interaction consumers must fit into this stack via z-positioning.
  // Do not change z-offsets without understanding this ordering.
  // Drag-time snap uses findSnapTarget() in Dragging.tsx (full scan, dragged element hidden).
  // Draw-time snap reads hoveredVertexPosition from the store (VertexDots does the raycast hover).
  return (
    <group ref={groupRef} rotation={rot} position={pos ?? [0, 0, 0]}>
      {topology && <TopologySurfaces topology={topology} featureId={featureId} isEditing={isEditing} activeFeatureId={activeFeatureId} />}
      {topology && <TopologyEdges topology={topology} featureId={featureId} isEditing={isEditing} activeFeatureId={activeFeatureId} />}
      <EntityLines sketch={displaySketch} featureId={featureId} color={entityStatus ? getEntityColor : baseColor} lineWidth={2} kindMap={kindMap} isEditing={isEditing} planeGroupRef={groupRef} showDebugHit={showDebugHit ?? false} />
      <ProjectedEntities sketch={displaySketch} featureId={featureId} />
      {constraints && isEditing && <ConstraintOverlays constraints={constraints} sketch={displaySketch} extent={extent} featureId={featureId} />}
      {isEditing && <DragPlane featureId={featureId} sketch={displaySketch} sketchGroupRef={groupRef} otherSketches={otherSketches} />}
      {isEditing && <DragSnapIndicator />}
      {isEditing && <DragAlignmentIndicator />}
      <DrawPreview activeFeatureId={activeFeatureId} />
      <DrawPlane featureId={featureId} activeFeatureId={activeFeatureId} sketch={displaySketch} sketchGroupRef={groupRef} otherSketches={otherSketches} />
    </group>
  )
}

// Re-export components for external use if needed
export { VertexDot, HitPolyline, VertexHighlight, ProjectedOriginPoint }
export { EntityLines, ProjectedEntities }
export { ConstraintOverlays }
export { TopologySurfaces, TopologyEdges }
export { DragPlane, DragSnapIndicator, DragAlignmentIndicator }
export { DrawPreview, DrawPlane }
