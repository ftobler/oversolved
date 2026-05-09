import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import type { Sketch } from '../../types/cad'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { toolRegistry } from '../../registry/toolRegistry'
import { Dot, VertexHighlight } from './VertexDots'
import { DashedLine } from '../sketch_dimensions'
import { p2w } from '../sketch_helpers'
import { useDynamicSelectionPositions } from '../interaction/snapHooks'
import { COLOR_SNAP, COLOR_PREVIEW, POINT_HIT_PIXELS } from './constants'
import { sanitizePointerEvent } from './pointerAbstractionAdapters'
import { computeDragMove, shouldActivateDrag } from './dragLogic'
import type { DragToolContext } from '../../tools/DragTool'
import { sketchToVertexCandidates, sketchToEntityCandidates } from './snapDetection'

export function DragPlane({ featureId, sketch, sketchGroupRef, showDebugHit, otherSketches }: {
  featureId: string
  sketch?: Sketch
  sketchGroupRef?: React.RefObject<THREE.Group | null>
  showDebugHit?: boolean
  otherSketches?: Record<string, Sketch>
}) {
  const meshRef = useRef<THREE.Mesh>(null)
  const prevNearbyRef = useRef<Set<string>>(new Set())
  const drag = useSketchEditorStore(s => s.drag)
  const dragPending = useSketchEditorStore(s => s.dragPending)
  const setDrag = useSketchEditorStore(s => s.setDrag)
  const setDragPending = useSketchEditorStore(s => s.setDragPending)
  const setDragStartClient = useSketchEditorStore(s => s.setDragStartClient)
  const setDragSnap = useSketchEditorStore(s => s.setDragSnap)
  const setAlignmentSnap = useSketchEditorStore(s => s.setAlignmentSnap)
  const setOrbitEnabled = useSketchEditorStore(s => s.setOrbitEnabled)
  const onMutation = useSketchEditorStore(s => s.onMutation)
  const dynamicSelection = useSketchEditorStore(s => s.dynamicSelection)
  const { camera, gl } = useThree()

  // Build map of dynamic selection positions for alignment detection
  const dynamicSelectionPositions = useDynamicSelectionPositions(sketch, dynamicSelection)

  // Resolve the sketch group ref: prefer explicit prop, fall back to mesh parent.
  const resolvedGroupRef: React.RefObject<THREE.Object3D | null> = sketchGroupRef ?? {
    get current() { return meshRef.current?.parent ?? null },
  }

  // Fallback: if pointer is released outside the canvas the Three.js onPointerUp
  // never fires, leaving orbitEnabled=false permanently. Listen on window instead.
  useEffect(() => {
    if (!drag && !dragPending) return
    const cancel = () => {
      setDrag(null)
      setDragPending(null)
      setDragStartClient(null)
      setDragSnap(null)
      setOrbitEnabled(true)
    }
    window.addEventListener('pointerup', cancel)
    return () => window.removeEventListener('pointerup', cancel)
  }, [drag, dragPending, setDrag, setDragPending, setDragStartClient, setDragSnap, setOrbitEnabled])

  // Window-level pointermove: bypasses R3F event bubbling so scene geometry (Body3D, Surfaces)
  // can never block drag events. The handler ref is updated every render so the closure always
  // captures fresh props/derived values without listing them as useEffect dependencies.
  const handleMoveRef = useRef<((e: PointerEvent) => void) | null>(null)
  handleMoveRef.current = (e: PointerEvent) => {
    const mesh = meshRef.current
    if (!mesh) return

    // Read from store imperatively to see the latest drag state, including any update
    // that setDrag() makes mid-handler (lazy drag initiation below).
    const { drag, dragPending, dragStartClient, isPointerDown, dynamicSelection, normalSelection } = useSketchEditorStore.getState()
    if (!drag && !dragPending) return
    // Only the DragPlane whose featureId matches the active drag processes this event.
    if (drag && drag.featureId !== featureId) return
    if (!drag && dragPending && dragPending.featureId !== featureId) return

    // Live canvas bounds: not cached so sidebar resizes are reflected immediately.
    const rect = gl.domElement.getBoundingClientRect()
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1
    const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1

    // Raycast against this mesh only -- equivalent to the former onPointerMove path
    // but immune to other scene geometry intercepting the event.
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera)
    const hits = raycaster.intersectObject(mesh, false)
    if (hits.length === 0) return

    const worldPt = hits[0].point
    const sanitized = sanitizePointerEvent({ point: worldPt, clientX: e.clientX, clientY: e.clientY }, resolvedGroupRef)
    if (!sanitized) return
    const localPoint = sanitized.localPoint

    if (showDebugHit) {
      console.log('DEBUG RAYCAST:', { clientX: e.clientX, clientY: e.clientY, world: { x: worldPt.x, y: worldPt.y, z: worldPt.z } })
    }

    // Lazy drag initiation: activate when movement exceeds the click threshold.
    // Dim_label drags are handled inline; vertex/edge drags route through DragTool.
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
        } else {
          const dragTool = toolRegistry.get('drag')
          if (dragTool) {
            const state = useSketchEditorStore.getState()
            const ctx: DragToolContext = {
              normalSelection: state.normalSelection,
              internalHoverSelection: state.internalHoverSelection,
              dynamicSelection: state.dynamicSelection,
              isPointerDown: state.isPointerDown,
              activeFeatureId: state.activeFeatureId,
              hoveredVertexId: dragPending.vertexId,
              hoveredVertexPosition: [dragPending.startWorld[0], dragPending.startWorld[1]],
              hoveredSnapKind: state.hoveredSnapKind,
              onMutation: state.onMutation,
              drag: null,
              dragPending,
              dragSnap: state.dragSnap,
              setDrag,
              setDragPending,
              setDragSnap,
              startClient: dragStartClient,
              setOrbitEnabled,
            }
            dragTool.handlers.onPointerMove?.(e, dragPending.startWorld, null, ctx)
          }
        }
      }
    }

    // Re-read after the potential setDrag() call above.
    const currentDrag = useSketchEditorStore.getState().drag
    if (!currentDrag) return

    if (currentDrag.type === 'vertex' && sketch) {
      const pixelsPerUnit = p2w(camera)
      // Build flat candidate arrays from sketch (adapter layer responsibility)
      const vertexCandidates = sketchToVertexCandidates(sketch, featureId, 'active_sketch')
      const entityCandidates = sketchToEntityCandidates(sketch, featureId, 'active_sketch')
      const skipIds = new Set<string>()
      skipIds.add(currentDrag.entityId)
      // Add other sketch candidates if provided
      if (otherSketches) {
        for (const [otherFeatId, otherSketch] of Object.entries(otherSketches)) {
          vertexCandidates.push(...sketchToVertexCandidates(otherSketch, otherFeatId, 'other_sketch'))
          entityCandidates.push(...sketchToEntityCandidates(otherSketch, otherFeatId, 'other_sketch'))
        }
      }
      const result = computeDragMove(
        localPoint,
        vertexCandidates,
        entityCandidates,
        skipIds,
        currentDrag,
        dynamicSelection,
        normalSelection,
        dynamicSelectionPositions,
        prevNearbyRef.current,
        pixelsPerUnit,
      )

      setDragSnap(result.snapTarget)

      if (result.alignmentSnap) {
        setAlignmentSnap(result.alignmentSnap.point, result.alignmentSnap.kind, result.alignmentSnap.vertexId)
      } else {
        setAlignmentSnap(null, null, null)
      }

      // Dispatch newly-entered proximity IDs to dynamic selection.
      const { updateDynamicSelection } = useSketchEditorStore.getState()
      for (const id of result.newProximityIds) {
        updateDynamicSelection(id)
      }
      prevNearbyRef.current = result.allProximityIds

      setDrag({ ...currentDrag, currentWorld: result.effectivePosition })
    } else {
      setDrag({ ...currentDrag, currentWorld: localPoint })
    }
  }

  useEffect(() => {
    if (!drag && !dragPending) return
    const handler = (e: PointerEvent) => handleMoveRef.current?.(e)
    window.addEventListener('pointermove', handler)
    return () => window.removeEventListener('pointermove', handler)
  }, [drag, dragPending])

  // Render DragPlane when drag is active OR when there's a pending drag (waiting for movement threshold)
  const shouldRender = drag !== null || dragPending !== null
  if (!shouldRender) return null

  return (
    <mesh
      ref={meshRef}
      position={[0, 0, 0]}
      onPointerUp={(e) => {
        e.stopPropagation()
        useSketchEditorStore.getState().setIsPointerDown(false)
        useSketchEditorStore.setState({ dynamicSelection: new Set() })
        prevNearbyRef.current = new Set()

        const { drag: currentDrag, dragPending } = useSketchEditorStore.getState()

        if (!currentDrag && dragPending && dragPending.featureId === featureId) {
          setDragPending(null)
          setDragStartClient(null)
          setOrbitEnabled(true)
          return
        }

        if (!currentDrag || currentDrag.featureId !== featureId) {
          setDrag(null); setDragSnap(null); setOrbitEnabled(true); return
        }

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
          setDrag(null); setDragSnap(null); setOrbitEnabled(true)
        } else {
          const dragTool = toolRegistry.get('drag')
          if (dragTool) {
            const state = useSketchEditorStore.getState()
            const context: DragToolContext = {
              normalSelection: state.normalSelection,
              internalHoverSelection: state.internalHoverSelection,
              dynamicSelection: state.dynamicSelection,
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
              setOrbitEnabled,
            }
            dragTool.handlers.onPointerUp?.(e.nativeEvent, currentDrag.currentWorld, null, context)
          } else {
            setDrag(null); setDragSnap(null); setOrbitEnabled(true)
          }
        }
      }}
    >
      <planeGeometry args={[10000, 10000]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  )
}

/** Visual indicator shown at the snap target position while dragging. */
export function DragSnapIndicator() {
  const dragSnap = useSketchEditorStore(s => s.dragSnap)
  if (!dragSnap) return null
  const [x, y] = dragSnap.position
  return (
    <>
      <Dot x={x} y={y} px={6} color={COLOR_SNAP} billboard />
      <VertexHighlight x={x} y={y} px={POINT_HIT_PIXELS * 0.3} color={COLOR_SNAP} />
    </>
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


