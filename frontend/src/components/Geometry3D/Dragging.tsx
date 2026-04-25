import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import type { Sketch, LineSegment, Circle, Arc, PointEntity } from '../../types/cad'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { Dot, VertexHighlight } from './VertexDots'
import { DashedLine } from '../sketch_dimensions'
import { p2w } from '../sketch_helpers'
import { useDynamicSelectionPositions } from '../interaction/snapHooks'
import { COLOR_SNAP, COLOR_PREVIEW, POINT_HIT_PIXELS } from './constants'
import { sanitizePointerEvent } from './pointerAbstractionAdapters'
import { computeDragMove, computeDragMutation, shouldActivateDrag } from './dragLogic'

export function DragPlane({ featureId, sketch, sketchGroupRef, showDebugHit }: {
  featureId: string
  sketch?: Sketch
  sketchGroupRef?: React.RefObject<THREE.Group | null>
  showDebugHit?: boolean
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
          setDrag({
            type: dragPending.type,
            vertexId: dragPending.vertexId,
            featureId: dragPending.featureId,
            entityId: dragPending.entityId,
            vertexKey: dragPending.vertexKey,
            startWorld: dragPending.startWorld,
            currentWorld: dragPending.startWorld,
            startClient: dragStartClient,
          })
        }
      }
    }

    // Re-read after the potential setDrag() call above.
    const currentDrag = useSketchEditorStore.getState().drag
    if (!currentDrag) return

    if (currentDrag.type === 'vertex' && sketch) {
      const pixelsPerUnit = p2w(camera)
      const result = computeDragMove(
        localPoint,
        sketch,
        featureId,
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
        // Clear drag-mode dynamic selection before the window pointerup listener fires.
        // The drag plane populates dynamicSelection with proximity-scanned alignment refs
        // during drag -- these must not be applied to normalSelection on pointer-up.
        useSketchEditorStore.getState().setIsPointerDown(false)
        useSketchEditorStore.setState({ dynamicSelection: new Set() })
        prevNearbyRef.current = new Set()

        // Read from store directly -- not from the render closure -- to avoid stale values.
        const { drag: currentDrag, dragSnap: currentDragSnap, dragPending, alignmentSnapKind, alignmentSnapPoint, alignmentSnapVertexId } = useSketchEditorStore.getState()

        // If drag never initiated (pure click), clear pending state and return
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
          // Dimension label drag: emit position mutation
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
        } else {
          // Vertex or edge drag: delegate to pure dragLogic
          const endClient: [number, number] = [e.nativeEvent.clientX, e.nativeEvent.clientY]
          const alignmentSnap = (alignmentSnapKind && alignmentSnapPoint && alignmentSnapVertexId)
            ? { point: alignmentSnapPoint, kind: alignmentSnapKind, vertexId: alignmentSnapVertexId }
            : null
          const mutation = computeDragMutation(endClient, currentDrag, currentDragSnap, alignmentSnap)
          if (mutation && onMutation) onMutation(mutation)
        }

        setDrag(null)
        setDragSnap(null)
        setOrbitEnabled(true)
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

/** Apply drag offset to sketch for optimistic preview.
 *  Dimension label drags (dim_label) don't affect entity geometry -- the optimistic
 *  position is handled inside each dimension component via the drag store. */
// eslint-disable-next-line react-refresh/only-export-components
export function applyDragPreview(sketch: Sketch, drag: import('../../stores/sketchEditorStore').DragState): Sketch {
  if (drag.type === 'dim_label') return sketch
  const dx = drag.currentWorld[0] - drag.startWorld[0]
  const dy = drag.currentWorld[1] - drag.startWorld[1]
  if (dx === 0 && dy === 0) return sketch
  const result = structuredClone(sketch)
  const entity = result[(drag as { entityId: string }).entityId]
  if (!entity) return sketch

  const d = drag as { type: string; entityId: string; vertexKey: string }
  if (d.type === 'edge') {
    if ('start' in entity && 'end' in entity) {
      const l = entity as LineSegment
      l.start = [l.start[0] + dx, l.start[1] + dy]
      l.end = [l.end[0] + dx, l.end[1] + dy]
    } else if ('center' in entity) {
      const c = entity as Circle | Arc
      c.center = [c.center[0] + dx, c.center[1] + dy]
    } else if ('x' in entity) {
      const p = entity as PointEntity
      p.x += dx; p.y += dy
    }
    return result
  }

  const key = d.vertexKey
  if ('start' in entity && 'end' in entity && 'radius' in entity && key === 'start') {
    (entity as Arc).start = [drag.currentWorld[0], drag.currentWorld[1]]
  } else if ('start' in entity && 'end' in entity && 'radius' in entity && key === 'end') {
    (entity as Arc).end = [drag.currentWorld[0], drag.currentWorld[1]]
  } else if ('start' in entity && 'end' in entity && key === 'start') {
    (entity as LineSegment).start = [drag.currentWorld[0], drag.currentWorld[1]]
  } else if ('start' in entity && 'end' in entity && key === 'end') {
    (entity as LineSegment).end = [drag.currentWorld[0], drag.currentWorld[1]]
  } else if ('center' in entity && key === 'center') {
    (entity as Circle | Arc).center = [drag.currentWorld[0], drag.currentWorld[1]]
  } else if ('x' in entity && key === 'xy') {
    (entity as PointEntity).x = drag.currentWorld[0];
    (entity as PointEntity).y = drag.currentWorld[1]
  }
  return result
}
