import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import type { Sketch, Constraints, Topology, PlaneTransform, EntityStatus, PartFeature } from '@/types/cad'
import { useSketchEditorStore, type VertexOrEdgeDrag } from '@/stores/sketchEditorStore'

// Vertex/point rendering
import { VertexDot, VertexHighlight, ProjectedOriginPoint } from '@/components/Geometry3D/VertexDots'

// Entity geometry rendering
import { EntityLines, ProjectedEntities } from '@/components/Geometry3D/EntityLines'
import { sketchExtent } from '@/components/Geometry3D/drawGeometry'

// Constraint display
import { ConstraintOverlays } from '@/components/Geometry3D/Constraints'
import { DimensionPreview } from '@/components/Geometry3D/dimensions/Preview'

// Topology surface rendering
import { TopologySurfaces } from '@/components/Geometry3D/Surfaces'

// Dragging
import { DragPlane, DragSnapIndicator, DragAlignmentIndicator } from '@/components/Geometry3D/Dragging'

// Inferred contact points: tangencies + curve-curve intersections (lazy inferred materialization)
import { InferredContactMarkers } from '@/components/Geometry3D/InferredContactMarkers'

// Edge drag preview: frontend-only translation of the dragged entity's vertices.
// No constraint resolution -- the WASM hard solve handles that on pointer-up.
import { edgeDragPreview } from '@/utils/geometry/edgeDragPreview'

// WASM drag solve: runs the real solver on every drag frame.
import { useWasmDragSolve } from '@/hooks/useWasmDragSolve'

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
  featureDef?: PartFeature
}

export default function Geometry3D({ featureId, solved, entities, constraints, topology, activeFeatureId, plane, planeTransform, solveStatus, entityStatus, otherSketches, featureDef }: Geometry3DProps) {
  const groupRef = useRef<THREE.Group>(null)
  const drag = useSketchEditorStore(s => s.drag)
  const isDraggingThis = !!drag && drag.featureId === featureId

  // WASM drag solve for vertex drags (runs the real solver per frame with
  // warm-start continuity and rAF throttling). engaged=false for edge/dim_label
  // drags, unmapped vertices, or while the main-thread solver is still loading.
  const wasmDrag = useWasmDragSolve({ featureId, featureDef, drag, isDraggingThis })

  // During drag on this feature: vertex drags use WASM; edge drags use a simple
  // translation preview (no constraint resolution -- the hard solve handles it
  // on pointer-up). While WASM is engaged but before the first frame lands (at
  // most one rAF tick), preview is null and displaySketch falls through to
  // `solved` -- no disagreement with the first WASM frame. Hard solve fires on
  // pointer-up via onMutation (unchanged).
  const preview = useMemo(
    () => {
      if (!drag || drag.featureId !== featureId) return null
      if (drag.type === 'vertex' && wasmDrag.engaged) return wasmDrag.sketch
      if (drag.type === 'edge') return edgeDragPreview(solved, drag as VertexOrEdgeDrag & { type: 'edge' })
      if (drag.type === 'dim_label') return solved
      return null
    },
    // Depend on the result fields, not the result object: the hook returns a
    // fresh object every render, which would defeat the memo.
    [solved, drag, featureId, wasmDrag.engaged, wasmDrag.sketch],
  )

  // On pointer-up the committed mutation re-solves asynchronously. Until the
  // fresh `solved` arrives we keep showing the last drag preview, so the geometry
  // doesn't snap back to its pre-drag position for the solver round-trip.
  // Derived synchronously via the "adjust state during render" pattern (no effect,
  // so no one-frame revert). A new `solved` identity supersedes the held preview.
  const [held, setHeld] = useState<Sketch | null>(null)
  const [tracker, setTracker] = useState<{ solved: Sketch; preview: Sketch | null }>({ solved, preview })
  let nextHeld = held
  if (tracker.solved !== solved || tracker.preview !== preview) {
    if (tracker.solved !== solved) {
      nextHeld = null  // fresh solve replaces the hold
    } else if (tracker.preview && !preview) {
      nextHeld = tracker.preview  // drag just ended: freeze its last preview
    }
    setTracker({ solved, preview })
  }
  if (nextHeld !== held) setHeld(nextHeld)

  // During drag: preview, falling back to `solved` for the engaged-but-first-
  // frame-pending window. After drag: the held preview until a fresh solve.
  const displaySketch = isDraggingThis ? (preview ?? nextHeld ?? solved) : (nextHeld ?? solved)

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

  // Register the held-or-solved sketch, NOT displaySketch: displaySketch is
  // replaced every drag tick, which would unregister/re-allocate per frame.
  // The ID buffer doesn't need mid-drag accuracy because selection is disabled
  // during drag. But after pointer-up the real solver's held preview can be
  // far from `solved` (whole constraint chains move), so re-register from the
  // held sketch once at drag end -- hover/pick then matches what is on screen
  // while the commit solve is in flight.
  // Inactive sketches stay inert (ID buffer excludes their layers; Surfaces.tsx R3F handlers bail out via isInactive)
  // behavior for non-active sketches). When no sketch is being edited, all
  // sketches register so they can be picked from the assembly view.
  useSketchIdRegistration({
    featureId,
    sketch: nextHeld ?? solved,
    planeTransform: resolvedPlaneTransform,
    enabled: !activeFeatureId || isEditing,
    constraints: featureDef?.constraints,
    topology,
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
  //   3. Sketch topology surfaces (z=0; no world offset - fill is decoration, picking is via the ID buffer)
  //   4. DragPlane mesh          (z=0, mounted only when drag != null - owns all move/up events during drag)
  //   5. DrawPlane mesh          (z=-0.002, mounted only when activeTool is a drawing tool)
  //   6. B-rep faces/edges       (always interactive)
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
      <EntityLines sketch={displaySketch} featureId={featureId} color={entityStatus ? getEntityColor : baseColor} lineWidth={2} kindMap={kindMap} isEditing={isEditing} constraints={featureDef?.constraints} />
      <ProjectedEntities sketch={displaySketch} featureId={featureId} isEditing={isEditing} />
      {constraints && isEditing && <ConstraintOverlays constraints={constraints} sketch={displaySketch} extent={extent} featureId={featureId} planeTransform={resolvedPlaneTransform} />}
      {isEditing && <InferredContactMarkers sketch={displaySketch} featureId={featureId} constraints={featureDef?.constraints} topology={topology} />}
      {isEditing && <DragPlane featureId={featureId} sketch={displaySketch} sketchGroupRef={groupRef} otherSketches={otherSketches} constraints={featureDef?.constraints} topology={topology} />}
      {isEditing && <DragSnapIndicator />}
      {isEditing && <DragAlignmentIndicator />}
      <DrawPreview activeFeatureId={activeFeatureId} />
      <DrawPlane featureId={featureId} activeFeatureId={activeFeatureId} sketch={displaySketch} sketchGroupRef={groupRef} otherSketches={otherSketches} />
      {isEditing && <DimensionPreview featureId={featureId} activeFeatureId={activeFeatureId} sketch={displaySketch} planeTransform={resolvedPlaneTransform} />}
    </group>
  )
}

// Re-export components for external use if needed
export { VertexDot, VertexHighlight, ProjectedOriginPoint }
export { EntityLines, ProjectedEntities }
export { ConstraintOverlays }
export { TopologySurfaces }
export { DragPlane, DragSnapIndicator, DragAlignmentIndicator }
export { DrawPreview, DrawPlane }
