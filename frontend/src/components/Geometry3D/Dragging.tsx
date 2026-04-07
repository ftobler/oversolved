import { useEffect, useRef, useMemo } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import type { Sketch, LineSegment, Circle, Arc, PointEntity, Entity } from '../../types/cad'
import { isProjectedEntity } from '../../types/cad'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { Dot, VertexHighlight } from './VertexDots'
import { DashedLine } from '../sketch_dimensions'
import { p2w } from '../sketch_helpers'
import { nearestPointOnEntity } from './nearestPoint'
import { suggestConstraint, detectAlignmentSnap, type DraggedElementType, type SnapKind } from '../../registry'
import { COLOR_SNAP, COLOR_PREVIEW, DRAG_SNAP_VERTEX_RADIUS_PX, DRAG_SNAP_ENTITY_RADIUS_PX, POINT_HIT_PIXELS } from './constants'

// Snap kind discriminator:
//   'vertex' — cursor is close to a specific named vertex
//   'entity' — cursor is close to an entity body but not to a vertex
// Vertex snap uses a larger pull radius and takes priority.
export type DragSnapKind = 'vertex' | 'entity'

export interface SnapTarget {
  kind: DragSnapKind
  position: [number, number]
  constraintKind: string   // from suggestConstraint — same registry as drawing snap
  vertexId?: string        // set when kind === 'vertex'; format: "vertex:featureId:entityId:key"
  entityRef?: string       // set when kind === 'entity';  format: "entity:featureId:entityId"
}



interface VertexCandidate {
  vertexId: string
  position: [number, number]
  snapKind: SnapKind  // what kind of snap target this vertex is
}

/** Collect all discrete vertex positions from a sketch with their snap kinds.
 *  Excludes projected entities and the entity currently being dragged.
 *  All point handles are treated as 'vertex' snap kind (broad categorization). */
// eslint-disable-next-line react-refresh/only-export-components
export function collectVertexTargets(sketch: Sketch, featureId: string, skipEntityId: string): VertexCandidate[] {
  const targets: VertexCandidate[] = []
  for (const [entityId, entity] of Object.entries(sketch)) {
    if (isProjectedEntity(entity as Entity)) continue
    if (entityId === skipEntityId) continue

    if ('start' in entity && 'end' in entity) {
      const l = entity as LineSegment | Arc
      targets.push({ vertexId: `vertex:${featureId}:${entityId}:start`, position: l.start, snapKind: 'vertex' })
      targets.push({ vertexId: `vertex:${featureId}:${entityId}:end`,   position: l.end,   snapKind: 'vertex' })
      // Arc center is just another vertex point
      if ('radius' in l && 'angle_start' in l) {
        targets.push({ vertexId: `vertex:${featureId}:${entityId}:center`, position: (l as Arc).center, snapKind: 'vertex' })
      }
    } else if ('center' in entity && 'radius' in entity) {
      const c = entity as Circle
      targets.push({ vertexId: `vertex:${featureId}:${entityId}:center`, position: c.center, snapKind: 'vertex' })
    } else if ('x' in entity) {
      const p = entity as PointEntity
      targets.push({ vertexId: `vertex:${featureId}:${entityId}:xy`, position: [p.x, p.y], snapKind: 'vertex' })
    }
  }
  return targets
}

/** Find the best snap target using the same snap registry as the drawing tools.
 *  Vertex snap uses a larger pull radius than entity snap, mirroring
 *  POINT_HIT_PIXELS > HIT_PIXELS in click detection.
 *  Returns null if the registry does not allow snapping in the current configuration. */
// eslint-disable-next-line react-refresh/only-export-components
export function findSnapTarget(
  sketch: Sketch,
  featureId: string,
  skipEntityId: string,
  draggedType: DraggedElementType,  // 'vertex' or 'entity' being dragged
  x: number,
  y: number,
  vertexThreshold: number,    // world units, for vertex snap (larger)
  entityThreshold: number,    // world units, for entity body snap (smaller)
): SnapTarget | null {
  // First pass: find nearest vertex within its (larger) pull zone.
  // Only keep candidates that the snap registry allows.
  let bestVertex: (VertexCandidate & { dist: number }) | null = null
  let bestVertexDist = vertexThreshold
  for (const t of collectVertexTargets(sketch, featureId, skipEntityId)) {
    const d = Math.hypot(t.position[0] - x, t.position[1] - y)
    if (d < bestVertexDist) {
      const cKind = suggestConstraint(draggedType, t.snapKind)
      if (cKind !== null) {
        bestVertexDist = d
        bestVertex = { ...t, dist: d }
      }
    }
  }
  if (bestVertex) {
    const cKind = suggestConstraint(draggedType, bestVertex.snapKind)!
    return { kind: 'vertex', position: bestVertex.position, constraintKind: cKind, vertexId: bestVertex.vertexId }
  }

  // Second pass: find nearest point on entity body (smaller pull zone,
  // only fires when no vertex is within its larger zone).
  let bestEntity: SnapTarget | null = null
  let bestEntityDist = entityThreshold
  for (const [entityId, entity] of Object.entries(sketch)) {
    if (isProjectedEntity(entity as Entity)) continue
    if (entityId === skipEntityId) continue
    const cKind = suggestConstraint(draggedType, 'path')
    if (cKind === null) continue  // registry disallows path snap for this dragged type
    const result = nearestPointOnEntity(x, y, entity as Entity)
    if (result && result.distance < bestEntityDist) {
      bestEntityDist = result.distance
      bestEntity = {
        kind: 'entity',
        position: result.position as [number, number],
        constraintKind: cKind,
        entityRef: `entity:${featureId}:${entityId}`,
      }
    }
  }
  return bestEntity
}

export function DragPlane({ featureId, sketch, showDebugHit }: { featureId: string; sketch?: Sketch; showDebugHit?: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null)
  const drag = useSketchEditorStore(s => s.drag)
  const setDrag = useSketchEditorStore(s => s.setDrag)
  const setDragSnap = useSketchEditorStore(s => s.setDragSnap)
  const setOrbitEnabled = useSketchEditorStore(s => s.setOrbitEnabled)
  const onMutation = useSketchEditorStore(s => s.onMutation)
  const dynamicSelection = useSketchEditorStore(s => s.dynamicSelection)
  const setAlignmentSnap = useSketchEditorStore(s => s.setAlignmentSnap)
  const { camera } = useThree()

  // Build map of dynamic selection positions for alignment detection
  const dynamicSelectionPositions = useMemo(() => {
    const pos = new Map<string, [number, number]>()
    if (!sketch) return pos
    for (const id of dynamicSelection) {
      if (id.startsWith('vertex:')) {
        const parts = id.split(':')
        if (parts.length >= 4) {
          const [, , entityId, vertexKey] = parts
          const entity = sketch[entityId]
          if (entity) {
            if ('start' in entity && 'end' in entity) {
              const lineEntity = entity as LineSegment | Arc
              if (vertexKey === 'start') pos.set(id, lineEntity.start)
              else if (vertexKey === 'end') pos.set(id, lineEntity.end)
              else if (vertexKey === 'center' && 'radius' in entity) pos.set(id, (entity as Arc).center)
            } else if ('center' in entity && vertexKey === 'center') {
              pos.set(id, (entity as Circle).center)
            } else if ('x' in entity && vertexKey === 'xy') {
              const ptEntity = entity as PointEntity
              pos.set(id, [ptEntity.x, ptEntity.y])
            }
          }
        }
      } else if (id.startsWith('entity:')) {
        const parts = id.split(':')
        if (parts.length >= 3) {
          const [, , entityId] = parts
          const entity = sketch[entityId]
          if (entity) {
            if ('start' in entity && 'end' in entity) {
              const mid: [number, number] = [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2]
              pos.set(id, mid)
            } else if ('center' in entity) {
              pos.set(id, (entity as Circle).center)
            }
          }
        }
      }
    }
    return pos
  }, [dynamicSelection, sketch])

  // DragPlane is at z=0, perfectly aligned with the sketch plane.
  // Self-intersection blocking (dragged entity's collision geometry blocking raycasts)
  // is solved by hiding the collision geometry (HitPolyline, hit spheres, dim hit meshes) during drag.
  // This is done in EntityLines.tsx and VertexDots.tsx (isDragged) and sketch_dimensions.tsx (isDragged).

  const toLocal = (worldPt: THREE.Vector3): [number, number] | null => {
    const parent = meshRef.current?.parent
    if (!parent) return null
    // If Z is far from sketch plane (0), we're likely over an HTML overlay that shouldn't be raycasted
    if (Math.abs(worldPt.z) > 1) return null
    const parentPos = new THREE.Vector3()
    parent.getWorldPosition(parentPos)
    const q = new THREE.Quaternion()
    parent.getWorldQuaternion(q)
    const local = worldPt.clone().sub(parentPos).applyQuaternion(q.invert())
    return [local.x, local.y]
  }

  // Fallback: if pointer is released outside the canvas the Three.js onPointerUp
  // never fires, leaving orbitEnabled=false permanently. Listen on window instead.
  useEffect(() => {
    if (!drag || drag.featureId !== featureId) return
    const cancel = () => { setDrag(null); setDragSnap(null); setOrbitEnabled(true) }
    window.addEventListener('pointerup', cancel)
    return () => window.removeEventListener('pointerup', cancel)
  }, [drag, featureId, setDrag, setDragSnap, setOrbitEnabled])

  if (!drag) return null

  return (
    <mesh
      ref={meshRef}
      position={[0, 0, 0]}  // drag plane has not offset. is is perfectly at the sketch plane.
      onPointerMove={(e) => {
        e.stopPropagation()
        // Use manual raycasting to hit only the drag plane, ignoring other collision geometry
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
        const local = toLocal(worldPt)
        if (!local) return
        const [x, y] = local
        if (showDebugHit) {
          console.log('DEBUG RAYCAST:', { clientX: e.clientX, clientY: e.clientY, rayOrigin: ray?.origin, rayDir: ray?.direction, world: worldPt ? { x: worldPt.x, y: worldPt.y, z: worldPt.z } : 'no hit' })
        }

        // Snap detection and constraint application: vertex then entity, only for vertex drags.
        // When snap is detected, apply snap position immediately for visual feedback + constraint on release.
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
          console.log('ONPOINTERMOVE SNAP:', { x, y, snapFound: !!snap, snapPos: snap?.position })
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
        const { drag: currentDrag, dragSnap: currentDragSnap } = useSketchEditorStore.getState()
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
            // For vertex and edge drags, use screen-pixel distance threshold (4px) to distinguish
            // click-to-select from drag-to-move. Pixel-space threshold is independent of zoom level
            // and correctly ignores the hit-radius offset that occurs even on pure clicks.
            // See: dragging.test.ts REGRESSION 4
            const pixelDistance = Math.hypot(e.nativeEvent.clientX - finalDrag.startClient[0], e.nativeEvent.clientY - finalDrag.startClient[1])
            if (pixelDistance < 4) {
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
              console.log('DEBUG ONPOINTERUP:', { alignmentSnapKind, currentDragSnap, vertexId: currentDragSnap?.vertexId })
              if (alignmentSnapKind && alignmentSnapPoint && alignmentSnapVertexId) {
                const constraintKind = alignmentSnapKind === 'kinda_horizontal' ? 'horizontal' : 'vertical'
                console.log('EMIT: alignment snap constraint')
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
                console.log('EMIT: vertex snap constraint', { snapVertexId: currentDragSnap.vertexId })
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
                console.log('EMIT: move_vertex (NO CONSTRAINT)', { to: finalDrag.currentWorld })
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
