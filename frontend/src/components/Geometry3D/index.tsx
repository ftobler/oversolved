import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { Sketch, Constraints, Topology, PlaneTransform, EntityStatus, PartFeature } from '@/types/cad'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

// Vertex/point rendering
import { VertexDot, VertexHighlight, ProjectedOriginPoint } from '@/components/Geometry3D/VertexDots'

// Entity geometry rendering
import { EntityLines, ProjectedEntities } from '@/components/Geometry3D/EntityLines'
import { sketchExtent } from '@/components/Geometry3D/drawGeometry'

// Constraint display
import { ConstraintOverlays } from '@/components/Geometry3D/Constraints'

// Topology surface rendering
import { TopologySurfaces, TopologyEdges } from '@/components/Geometry3D/Surfaces'

// Dragging
import { DragPlane, DragSnapIndicator, DragAlignmentIndicator } from '@/components/Geometry3D/Dragging'

// Soft solve: frontend-only drag preview honoring coincidence constraints
import { softSolve } from '@/utils/softSolve'

// Drawing tools
import { DrawPreview, DrawPlane } from '@/components/Geometry3D/Drawing'

// Utilities
import { planeRotation, planeRotationFromTransform } from '@/components/Geometry3D/utils'
import { builtinPlaneTransform } from '@/components/Geometry3D/bodySnapProjection'

// Colors
import { COLOR_SOLVED, COLOR_FULLY_CONSTRAINED, COLOR_ERROR, COLOR_INACTIVE } from '@/components/Geometry3D/constants'

// ID-buffer registration
import { useSketchIdRegistration, useSketchSurfaceIdRegistration } from '@/picking'

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
  /** Full feature definition; used by soft solve to honour coincidence constraints during drag. */
  featureDef?: PartFeature
}

export default function Geometry3D({ featureId, solved, entities, constraints, topology, activeFeatureId, plane, planeTransform, solveStatus, entityStatus, otherSketches, featureDef }: Geometry3DProps) {
  const groupRef = useRef<THREE.Group>(null)
  const drag = useSketchEditorStore(s => s.drag)

  // During drag on this feature, show soft-solve preview (honours coincidence constraints,
  // other constraints relax silently). Hard solve fires on pointer-up via onMutation.
  const displaySketch = useMemo(() => {
    if (drag && drag.featureId === featureId) {
      return softSolve({ sketch: solved, drag, feature: featureDef })
    }
    return solved
  }, [solved, drag, featureId, featureDef])

  const extent = useMemo(() => sketchExtent(displaySketch), [displaySketch])

  const resolvedPlaneTransform: PlaneTransform | undefined = useMemo(() => {
    if (planeTransform) return planeTransform
    if (plane) return builtinPlaneTransform(plane) ?? undefined
    return undefined
  }, [planeTransform, plane])

  const rot = resolvedPlaneTransform
    ? planeRotationFromTransform(resolvedPlaneTransform)
    : planeRotation(plane)
  const pos = resolvedPlaneTransform?.origin as [number, number, number] | undefined
  const kindMap = useMemo(() =>
    Object.fromEntries((entities ?? []).map(e => [e.id, e.kind])),
    [entities]
  )

  const isEditing = featureId === activeFeatureId

  const setEntityKindMap = useSketchEditorStore(s => s.setEntityKindMap)
  useEffect(() => {
    if (!isEditing) return
    const compositeMap: Record<string, string> = {}
    for (const [eid, kind] of Object.entries(kindMap)) {
      compositeMap[`entity:${featureId}:${eid}`] = kind
    }
    setEntityKindMap(compositeMap)
    return () => setEntityKindMap({})
  }, [isEditing, featureId, kindMap, setEntityKindMap])

  // Register the SOLVED sketch (not displaySketch). displaySketch is replaced
  // each drag tick by softSolve, which would otherwise unregister/re-allocate
  // every pointermove. The ID buffer doesn't need mid-drag accuracy because
  // selection is disabled during drag.
  // Inactive sketches stay inert (ID buffer excludes their layers; Surfaces.tsx R3F handlers bail out via isInactive)
  // behavior for non-active sketches). When no sketch is being edited, all
  // sketches register so they can be picked from the assembly view.
  useSketchIdRegistration({
    featureId,
    sketch: solved,
    planeTransform: resolvedPlaneTransform,
    enabled: !activeFeatureId || isEditing,
  })

  useSketchSurfaceIdRegistration({
    featureId,
    topology: topology,
    planeTransform: resolvedPlaneTransform,
    enabled: !activeFeatureId || isEditing,
  })

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
  //   2. Entity lines           (z=0, depthTest false)
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
      {topology && <TopologySurfaces topology={topology} isEditing={isEditing} activeFeatureId={activeFeatureId} />}
      {topology && <TopologyEdges topology={topology} featureId={featureId} isEditing={isEditing} activeFeatureId={activeFeatureId} />}
      <EntityLines sketch={displaySketch} featureId={featureId} color={entityStatus ? getEntityColor : baseColor} lineWidth={2} kindMap={kindMap} isEditing={isEditing} />
      <ProjectedEntities sketch={displaySketch} featureId={featureId} />
      {constraints && isEditing && <ConstraintOverlays constraints={constraints} sketch={displaySketch} extent={extent} featureId={featureId} planeTransform={resolvedPlaneTransform} />}
      {isEditing && <DragPlane featureId={featureId} sketch={displaySketch} sketchGroupRef={groupRef} otherSketches={otherSketches} />}
      {isEditing && <DragSnapIndicator />}
      {isEditing && <DragAlignmentIndicator />}
      <DrawPreview activeFeatureId={activeFeatureId} />
      <DrawPlane featureId={featureId} activeFeatureId={activeFeatureId} sketch={displaySketch} sketchGroupRef={groupRef} otherSketches={otherSketches} />
    </group>
  )
}

// Re-export components for external use if needed
export { VertexDot, VertexHighlight, ProjectedOriginPoint }
export { EntityLines, ProjectedEntities }
export { ConstraintOverlays }
export { TopologySurfaces, TopologyEdges }
export { DragPlane, DragSnapIndicator, DragAlignmentIndicator }
export { DrawPreview, DrawPlane }
