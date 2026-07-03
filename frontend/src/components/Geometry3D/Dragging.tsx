import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import type { Sketch } from '@/types/cad'
import { useSketchEditorStore, getSketchCallback } from '@/stores/sketchEditorStore'
import { toolRegistry } from '@/registry/toolRegistry'
import { Dot } from '@/components/Geometry3D/VertexDots'
import { DashedLine } from '@/components/Geometry3D/dimensions'
import { p2w } from '@/utils/geometry/sketchHelpers'
import { COLOR_SNAP, COLOR_PREVIEW } from '@/components/Geometry3D/constants'
import { sanitizePointerEvent } from '@/components/Geometry3D/pointerAbstractionAdapters'
import { computeDragMove, shouldActivateDrag, collectCoincidentVertexIds } from '@/components/Geometry3D/dragLogic'
import type { PartConstraint, Topology } from '@/types/cad'
import type { DragToolContext } from '@/tools/DragTool'
import { sketchToVertexCandidates, sketchToEntityCandidates, inferredContactCandidates } from '@/components/Geometry3D/snapDetection'
import { projectCursorToSketchPlane } from '@/components/Geometry3D/dragMathPlane'

// Sketch dragging is the prime consumer of the camera-drag block: the
// drag/dragPending state this component sets and clears is what disables
// OrbitControls (see deriveOrbitEnabled in orbitEnabled.ts). Camera orbit is
// suppressed while a sketch element is being dragged so the two gestures do not
// fight. Because that block is keyed on this state, any path that sets it must
// also clear it on release; a lost release (e.g. a load race that unmounts this
// DragPlane mid-gesture) is recovered by the pointer-up gating in
// deriveOrbitEnabled rather than relying solely on the handlers here.
export function DragPlane({ featureId, sketch, sketchGroupRef, otherSketches, constraints, topology }: {
  featureId: string
  sketch?: Sketch
  sketchGroupRef?: React.RefObject<THREE.Group | null>
  otherSketches?: Record<string, Sketch>
  constraints?: PartConstraint[]
  topology?: Topology
}) {
  const drag = useSketchEditorStore(s => s.drag)
  const dragPending = useSketchEditorStore(s => s.dragPending)
  const setDrag = useSketchEditorStore(s => s.setDrag)
  const setDragPending = useSketchEditorStore(s => s.setDragPending)
  const setDragStartClient = useSketchEditorStore(s => s.setDragStartClient)
  const setDragSnap = useSketchEditorStore(s => s.setDragSnap)
  const setAlignmentSnap = useSketchEditorStore(s => s.setAlignmentSnap)
  const onMutation = getSketchCallback('onMutation')
  const { camera, gl } = useThree()

  const resolvedGroupRef: React.RefObject<THREE.Object3D | null> = sketchGroupRef ?? { current: null }

  // Window-level pointermove: bypasses R3F event bubbling so scene geometry (Body3D, Surfaces)
  // can never block drag events. The handler ref is updated every render so the closure always
  // captures fresh props/derived values without listing them as useEffect dependencies.
  const handleMoveRef = useRef<((e: PointerEvent) => void) | null>(null)
  const moveImpl = (e: PointerEvent) => {
    const group = resolvedGroupRef.current
    if (!group) return

    // Read from store imperatively to see the latest drag state, including any update
    // that setDrag() makes mid-handler (lazy drag initiation below).
    const { drag, dragPending, dragStartClient, isPointerDown } = useSketchEditorStore.getState()
    if (!drag && !dragPending) return
    // Feature editing handles are 3D-axis drags owned by the FeatureHandles
    // component, never by a sketch DragPlane.
    if (drag?.type === 'feature_handle' || (!drag && dragPending?.type === 'feature_handle')) return
    // Only the DragPlane whose featureId matches the active drag processes this event.
    if (drag && drag.featureId !== featureId) return
    if (!drag && dragPending && dragPending.featureId !== featureId) return

    // Live canvas bounds: not cached so sidebar resizes are reflected immediately.
    const rect = gl.domElement.getBoundingClientRect()
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1
    const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1

    // Math-plane projection -- no scene mesh involved, so no other geometry
    // can block the raycast. Replaces the former DragPlane mesh at z=-0.001
    // (#266 audit).
    const worldPt = projectCursorToSketchPlane(camera, group, { x: ndcX, y: ndcY })
    if (!worldPt) return
    const sanitized = sanitizePointerEvent({ point: worldPt, clientX: e.clientX, clientY: e.clientY }, resolvedGroupRef)
    if (!sanitized) return
    const localPoint = sanitized.localPoint

    // Lazy drag initiation: activate when movement exceeds the click threshold.
    // Dim_label drags handled inline; vertex/edge drags delegate to DragTool
    // so it can resolve startWorld for edge drags.
    if (!drag && dragPending && dragStartClient && isPointerDown) {
      if (shouldActivateDrag(dragStartClient, [e.clientX, e.clientY])) {
        if (dragPending.type === 'dim_label') {
          setDrag({
            type: 'dim_label',
            constraintId: dragPending.constraintId,
            featureId: dragPending.featureId,
            anchorWorld: dragPending.anchorWorld,
            startWorld: dragPending.startWorld,
            currentWorld: dragPending.startWorld,
          })
        } else if (dragPending.type !== 'feature_handle') {
          const dragTool = toolRegistry.get('drag')
          if (dragTool) {
            const state = useSketchEditorStore.getState()
            const ctx: DragToolContext = {
              normalSelection: state.normalSelection,
              hoveredSelectionId: state.hoveredSelectionId,
              isPointerDown: state.isPointerDown,
              activeFeatureId: state.activeFeatureId,
              hoveredVertexId: dragPending.vertexId,
              hoveredVertexPosition: [dragPending.startWorld[0], dragPending.startWorld[1]],
              hoveredSnapKind: state.hoveredSnapKind,
              onMutation: getSketchCallback('onMutation'),
              drag: null,
              dragPending,
              dragSnap: state.dragSnap,
              setDrag,
              setDragPending,
              setDragSnap,
              startClient: dragStartClient,
              pushMode: () => {},
              popMode: () => {},
            }
            // Pass localPoint (math-plane projected cursor) as worldPt so DragTool
            // can resolve startWorld for edge drags from the actual cursor position.
            dragTool.handlers.onPointerMove?.(e, localPoint, null, ctx)
          }
        }
      }
    }

    // Re-read after the potential setDrag() call above.
    const currentDrag = useSketchEditorStore.getState().drag
    if (!currentDrag || currentDrag.type === 'feature_handle') return

    // All drag types use raw localPoint for smooth movement. Snap and alignment
    // are computed separately without modifying the drag position, so the core
    // drag path is identical for vertex and edge drags (fixes #274 jitter bug
    // where computeDragMove's snap threshold oscillation caused vertex jumps).
    if (currentDrag.type === 'vertex' && sketch) {
      const pixelsPerUnit = p2w(camera)
      const vertexCandidates = sketchToVertexCandidates(sketch, featureId, 'active_sketch')
      // Inferred contacts (tangencies + curve-curve intersections) are 0-D snap
      // targets carrying a `dock:`/`isect:` handle; snapping to one materializes a
      // real point (lazy inferred materialization).
      vertexCandidates.push(...inferredContactCandidates(sketch, featureId, constraints ?? [], topology, 'active_sketch'))
      const entityCandidates = sketchToEntityCandidates(sketch, featureId, 'active_sketch')
      const skipIds = new Set<string>()
      // Qualify with featureId: candidate ids are `entity:${featureId}:${entityId}`
      // and `vertex:${featureId}:${entityId}:${key}`. The bare entityId matched
      // vertices (substring) but never entities (exact compare), so the dragged
      // entity itself stayed a snap target -- visible when dragging a point.
      skipIds.add(`${featureId}:${currentDrag.entityId}`)
      if (otherSketches) {
        for (const [otherFeatId, otherSketch] of Object.entries(otherSketches)) {
          vertexCandidates.push(...sketchToVertexCandidates(otherSketch, otherFeatId, 'other_sketch'))
          entityCandidates.push(...sketchToEntityCandidates(otherSketch, otherFeatId, 'other_sketch'))
        }
      }
      // Coincident partners of the dragged vertex move with it (WASM keeps
      // them on top of the dragged dot). Excluding them stops the snap indicator
      // from latching onto a partner sitting under the cursor.
      const bondedVertexIds = collectCoincidentVertexIds(
        constraints ?? [], featureId, currentDrag.entityId, currentDrag.vertexKey,
      )
      const filteredVertexCandidates = vertexCandidates.filter(c => !bondedVertexIds.has(c.id))

      const result = computeDragMove(
        localPoint, filteredVertexCandidates, entityCandidates, skipIds,
        currentDrag, pixelsPerUnit,
      )

      setDragSnap(result.snapTarget)
      setAlignmentSnap(null, null, null)
    }

    // Use raw localPoint for ALL drag types so vertex and edge drags
    // have identical smoothness. Snap/alignment are read-only feedback
    // and no longer affect the drag position.
    setDrag({ ...currentDrag, currentWorld: localPoint })
  }

  useEffect(() => { handleMoveRef.current = moveImpl })

  useEffect(() => {
    if (!drag && !dragPending) return
    const handler = (e: PointerEvent) => handleMoveRef.current?.(e)
    window.addEventListener('pointermove', handler)
    return () => window.removeEventListener('pointermove', handler)
  }, [drag, dragPending])

  // Window-level pointerup commit. Fires for any pointer release while a
  // drag/dragPending exists for this featureId; the body filters by
  // featureId so unrelated DragPlane instances stay no-ops. Replaces the
  // former mesh-level R3F onPointerUp (#266 audit), which is no longer
  // needed now that no mesh exists.
  const handleUpRef = useRef<((e: PointerEvent) => void) | null>(null)
  const upImpl = (e: PointerEvent) => {
    useSketchEditorStore.getState().setIsPointerDown(false)

    const { drag: currentDrag, dragPending } = useSketchEditorStore.getState()

    if (!currentDrag && dragPending && dragPending.featureId === featureId) {
      setDragPending(null)
      setDragStartClient(null)
      return
    }

    if (!currentDrag || currentDrag.featureId !== featureId) {
      // Either no drag for us, or another sketch's DragPlane owns it.
      return
    }
    // Feature-handle drags are owned end-to-end by the FeatureHandles
    // component (their featureId is a brep feature, never a sketch's).
    if (currentDrag.type === 'feature_handle') return

    if (currentDrag.type === 'dim_label') {
      if (onMutation) {
        const pos: [number, number] = [
          currentDrag.currentWorld[0] - currentDrag.anchorWorld[0],
          currentDrag.currentWorld[1] - currentDrag.anchorWorld[1],
        ]
        const distance = Math.hypot(pos[0], pos[1])
        if (distance >= 0.0001) {
          onMutation({ type: 'set_constraint_pos', featureId: currentDrag.featureId, constraintId: currentDrag.constraintId, pos })
        }
      }
      setDrag(null); setDragSnap(null)
      return
    }

    const dragTool = toolRegistry.get('drag')
    if (!dragTool) {
      setDrag(null); setDragSnap(null)
      return
    }
    const state = useSketchEditorStore.getState()
    const context: DragToolContext = {
      normalSelection: state.normalSelection,
      hoveredSelectionId: state.hoveredSelectionId,
      isPointerDown: state.isPointerDown,
      activeFeatureId: state.activeFeatureId,
      hoveredVertexId: state.hoveredVertexId,
      hoveredVertexPosition: state.hoveredVertexPosition,
      hoveredSnapKind: state.hoveredSnapKind,
      onMutation,
      drag: currentDrag,
      dragPending: state.dragPending as DragToolContext['dragPending'],
      dragSnap: state.dragSnap,
      setDrag,
      setDragPending,
      setDragSnap,
      startClient: state.dragStartClient,
      pushMode: () => {},
      popMode: () => {},
    }
    dragTool.handlers.onPointerUp?.(e, currentDrag.currentWorld, null, context)
  }

  useEffect(() => { handleUpRef.current = upImpl })

  useEffect(() => {
    if (!drag && !dragPending) return
    const handler = (e: PointerEvent) => handleUpRef.current?.(e)
    window.addEventListener('pointerup', handler)
    return () => window.removeEventListener('pointerup', handler)
  }, [drag, dragPending])

  // Math-plane drag (#266): no scene-graph mesh required. The window-level
  // pointer listeners above own all move/up handling.
  return null
}

/** Visual indicator shown at the snap target position while dragging. */
export function DragSnapIndicator() {
  const dragSnap = useSketchEditorStore(s => s.dragSnap)
  if (!dragSnap) return null
  const [x, y] = dragSnap.position
  return (
    <Dot x={x} y={y} px={6} color={COLOR_SNAP} billboard />
  )
}

/** Visual indicator for alignment snap (kinda_horizontal/kinda_vertical). */
export function DragAlignmentIndicator() {
  const drag = useSketchEditorStore(s => s.drag)
  const alignmentSnapPoint = useSketchEditorStore(s => s.alignmentSnapPoint)
  const alignmentSnapKind = useSketchEditorStore(s => s.alignmentSnapKind)

  if (!drag || drag.type !== 'vertex' || !alignmentSnapPoint || !alignmentSnapKind) return null

  const [x, y] = drag.currentWorld
  return (
    <DashedLine
      points={[
        [alignmentSnapPoint[0], alignmentSnapPoint[1], 0],
        [x, y, 0],
      ]}
      color={COLOR_PREVIEW}
      lineWidth={1}
    />
  )
}


