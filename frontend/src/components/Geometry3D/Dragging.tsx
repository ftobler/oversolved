import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import type { Sketch, LineSegment, Circle, Arc, PointEntity } from '../../types/cad'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { Dot, VertexHighlight } from './VertexDots'
import { DashedLine } from '../sketch_dimensions'
import { p2w } from '../sketch_helpers'
import { detectAlignmentSnap } from '../../registry'
import { useDynamicSelectionPositions } from '../interaction/snapHooks'
import { COLOR_SNAP, COLOR_PREVIEW, DRAG_SNAP_VERTEX_RADIUS_PX, DRAG_SNAP_ENTITY_RADIUS_PX, POINT_HIT_PIXELS } from './constants'
import { sanitizePointerEvent, isPureClick, CLICK_THRESHOLD_PX } from './pointerAbstraction'
import { findSnapTarget } from './snapDetection'

export function DragPlane({ featureId, sketch, sketchGroupRef, showDebugHit }: {
  featureId: string
  sketch?: Sketch
  sketchGroupRef?: React.RefObject<THREE.Group | null>
  showDebugHit?: boolean
}) {
  const meshRef = useRef<THREE.Mesh>(null)
  const drag = useSketchEditorStore(s => s.drag)
  const dragPending = useSketchEditorStore(s => s.dragPending)
  const dragStartClient = useSketchEditorStore(s => s.dragStartClient)
  const setDrag = useSketchEditorStore(s => s.setDrag)
  const setDragPending = useSketchEditorStore(s => s.setDragPending)
  const setDragStartClient = useSketchEditorStore(s => s.setDragStartClient)
  const setDragSnap = useSketchEditorStore(s => s.setDragSnap)
  const setOrbitEnabled = useSketchEditorStore(s => s.setOrbitEnabled)
  const onMutation = useSketchEditorStore(s => s.onMutation)
  const dynamicSelection = useSketchEditorStore(s => s.dynamicSelection)
  const isPointerDown = useSketchEditorStore(s => s.isPointerDown)
  const setAlignmentSnap = useSketchEditorStore(s => s.setAlignmentSnap)
  const { camera } = useThree()

  // Build map of dynamic selection positions for alignment detection
  const dynamicSelectionPositions = useDynamicSelectionPositions(sketch, dynamicSelection)

  // DragPlane is at z=0, perfectly aligned with the sketch plane.
  // Self-intersection blocking (dragged entity's collision geometry blocking raycasts)
  // is solved by hiding the collision geometry (HitPolyline, hit spheres, dim hit meshes) during drag.
  // This is done in EntityLines.tsx and VertexDots.tsx (isDragged) and sketch_dimensions.tsx (isDragged).

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

  // Render DragPlane when drag is active OR when there's a pending drag (waiting for movement threshold)
  const shouldRender = drag !== null || dragPending !== null
  if (!shouldRender) return null

  return (
    <mesh
      ref={meshRef}
      position={[0, 0, 0]}  // drag plane has not offset. is is perfectly at the sketch plane.
      onPointerMove={(e) => {
        e.stopPropagation()
        // Manual raycasting is intentional here: R3F's e.point is resolved against the entire scene,
        // which can return a hit on a vertex sphere or edge cylinder instead of the drag plane.
        // We must raycast exclusively against this mesh so the coordinate reflects the drag plane position.
        // sanitizePointerEvent() then converts worldPt to sketch-local 2D via the shared abstraction.
        const scene = e.eventObject.parent?.parent?.parent ?? e.eventObject.parent
        if (!scene) return
        // Use the ray from the event instead of creating our own
        const ray = (e as unknown as { ray?: THREE.Ray }).ray
        if (!ray) return
        // Create raycaster and set its ray
        const raycaster = new THREE.Raycaster()
        raycaster.ray.copy(ray)
        // Only intersect the drag plane mesh
        const planeHit = raycaster.intersectObject(e.eventObject, false)
        if (planeHit.length === 0) return
        const worldPt = planeHit[0].point
        const sanitized = sanitizePointerEvent({ point: worldPt, clientX: e.clientX, clientY: e.clientY }, resolvedGroupRef)
        if (!sanitized) return
        const [x, y] = sanitized.localPoint
        if (showDebugHit) {
          console.log('DEBUG RAYCAST:', { clientX: e.clientX, clientY: e.clientY, rayOrigin: ray?.origin, rayDir: ray?.direction, world: worldPt ? { x: worldPt.x, y: worldPt.y, z: worldPt.z } : 'no hit' })
        }

        // Lazy drag initiation: if drag not yet started but we have pending drag and movement exceeded threshold
        if (!drag && dragPending && dragStartClient && isPointerDown && dragPending.featureId === featureId) {
          const dx = e.clientX - dragStartClient[0]
          const dy = e.clientY - dragStartClient[1]
          if (Math.hypot(dx, dy) >= CLICK_THRESHOLD_PX) {
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

        // If drag not yet initiated, skip drag logic
        if (!drag) return

        // Drag-snap uses proactive full-scan (findSnapTarget) here, synchronously during pointer-move,
        // so snapPosition can be applied to currentWorld in the same frame (no render-delay stutter).
        // Draw-snap is different: it reads hoveredVertexPosition from the store reactively, because the
        // draw tool does not need to override currentWorld — it just reads what the hover system found.
        let snapPosition: [number, number] | null = null
        if (drag.type === 'vertex' && sketch) {
          const pw = p2w(camera)
          const snap = findSnapTarget(
            sketch, drag.featureId, drag.entityId,
            'vertex',  // dragging a vertex handle
            x, y,
            DRAG_SNAP_VERTEX_RADIUS_PX * pw,
            DRAG_SNAP_ENTITY_RADIUS_PX * pw,
          )
          setDragSnap(snap)
          if (snap?.position) {
            snapPosition = snap.position
          }

          // Alignment detection for kinda_horizontal/kinda_vertical
          if (dynamicSelection.size > 0) {
            const alignment = detectAlignmentSnap(dynamicSelection, snapPosition ?? [x, y], dynamicSelectionPositions)
            if (alignment) {
              setAlignmentSnap(alignment.point, alignment.kind, alignment.vertexId)
              snapPosition = alignment.point
            } else {
              setAlignmentSnap(null, null, null)
            }
          }
        }

        // Apply snap position if detected, otherwise use raw cursor position
        setDrag({ ...drag, currentWorld: snapPosition ?? [x, y] })
      }}
      onPointerUp={(e) => {
        e.stopPropagation()
        // Read drag and dragSnap from store directly — not from the render closure.
        // onPointerUp may fire before React re-renders after the final onPointerMove,
        // so the closure could hold stale values. getState() always returns the latest.
        const { drag: currentDrag, dragSnap: currentDragSnap, dragPending } = useSketchEditorStore.getState()

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
        const finalDrag = { ...currentDrag }
        if (onMutation) {
          if (finalDrag.type === 'dim_label') {
            const pos: [number, number] = [
              finalDrag.currentWorld[0] - finalDrag.anchorWorld[0],
              finalDrag.currentWorld[1] - finalDrag.anchorWorld[1],
            ]
            const distance = Math.hypot(pos[0], pos[1])
            if (distance >= 0.0001) {
              onMutation({ type: 'set_constraint_pos', featureId: finalDrag.featureId, constraintId: finalDrag.constraintId, pos })
            }
          } else {
            // For vertex and edge drags, use screen-pixel distance threshold to distinguish
            // click-to-select from drag-to-move. Pixel-space is zoom-independent and correctly
            // ignores the hit-radius offset that occurs even on pure clicks.
            // See: dragging.test.ts REGRESSION 4
            const endClient: [number, number] = [e.nativeEvent.clientX, e.nativeEvent.clientY]
            if (isPureClick(finalDrag.startClient, endClient)) {
              // Pure click — don't emit mutation
              setDrag(null)
              setDragSnap(null)
              setOrbitEnabled(true)
              return
            }
            if (finalDrag.type === 'edge') {
              const delta: [number, number] = [
                finalDrag.currentWorld[0] - finalDrag.startWorld[0],
                finalDrag.currentWorld[1] - finalDrag.startWorld[1],
              ]
              onMutation({ type: 'move_entity', featureId: finalDrag.featureId, entityId: finalDrag.entityId, delta })
            } else if (finalDrag.type === 'vertex') {
              // Check for alignment snap first, then regular snap
              const { alignmentSnapKind, alignmentSnapPoint, alignmentSnapVertexId } = useSketchEditorStore.getState()
              if (alignmentSnapKind && alignmentSnapPoint && alignmentSnapVertexId) {
                const constraintKind = alignmentSnapKind === 'kinda_horizontal' ? 'horizontal' : 'vertical'
                onMutation({
                  type: 'move_vertex_with_constraint',
                  featureId: finalDrag.featureId,
                  entityId: finalDrag.entityId,
                  vertexKey: finalDrag.vertexKey,
                  to: alignmentSnapPoint,
                  constraintKind,
                  snapVertexId: alignmentSnapVertexId,
                })
              } else if (currentDragSnap?.kind === 'vertex') {
                onMutation({
                  type: 'move_vertex_with_constraint',
                  featureId: finalDrag.featureId,
                  entityId: finalDrag.entityId,
                  vertexKey: finalDrag.vertexKey,
                  to: currentDragSnap.position,
                  constraintKind: currentDragSnap.constraintKind,
                  snapVertexId: currentDragSnap.vertexId,
                })
              } else if (currentDragSnap?.kind === 'entity') {
                onMutation({
                  type: 'move_vertex_with_constraint',
                  featureId: finalDrag.featureId,
                  entityId: finalDrag.entityId,
                  vertexKey: finalDrag.vertexKey,
                  to: currentDragSnap.position,
                  constraintKind: currentDragSnap.constraintKind,
                  snapEntityRef: currentDragSnap.entityRef,
                })
              } else {
                onMutation({ type: 'move_vertex', featureId: finalDrag.featureId,
                  entityId: finalDrag.entityId, vertexKey: finalDrag.vertexKey, to: finalDrag.currentWorld })
              }
            }
          }
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
 *  Dimension label drags (dim_label) don't affect entity geometry — the optimistic
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
    // Translate the entire entity by delta
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
