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
import { suggestConstraint, detectAlignmentSnap } from '../../registry'
import type { SnapKind } from '../../registry'
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

/** Derive the entity kind string from an entity's structure.
 *  Mirrors the kind values in the entity registry (line, circle, arc, point). */
// eslint-disable-next-line react-refresh/only-export-components
export function entityKindOf(entity: Entity): string {
  if ('start' in entity && 'angle_start' in entity) return 'arc'
  if ('start' in entity) return 'line'
  if ('center' in entity) return 'circle'
  return 'point'
}

/** Derive the SnapKind for a target vertex, matching VertexDots.determineSnapKind.
 *  Used to look up the correct constraint via suggestConstraint. */
// eslint-disable-next-line react-refresh/only-export-components
export function vertexSnapKind(entityKind: string, vertexKey: string): SnapKind {
  if (vertexKey === 'center') return 'center'
  if (entityKind === 'point') return 'vertex'
  if (entityKind === 'circle') return 'center'
  return 'vertex'
}

interface VertexCandidate {
  vertexId: string
  position: [number, number]
  snapKind: SnapKind  // what kind of snap target this vertex is
}

/** Collect all discrete vertex positions from a sketch with their snap kinds.
 *  Excludes projected entities and the entity currently being dragged. */
// eslint-disable-next-line react-refresh/only-export-components
export function collectVertexTargets(sketch: Sketch, featureId: string, skipEntityId: string): VertexCandidate[] {
  const targets: VertexCandidate[] = []
  for (const [entityId, entity] of Object.entries(sketch)) {
    if (isProjectedEntity(entity as Entity)) continue
    if (entityId === skipEntityId) continue

    const eKind = entityKindOf(entity as Entity)
    if ('start' in entity && 'end' in entity) {
      const l = entity as LineSegment | Arc
      targets.push({ vertexId: `vertex:${featureId}:${entityId}:start`, position: l.start, snapKind: vertexSnapKind(eKind, 'start') })
      targets.push({ vertexId: `vertex:${featureId}:${entityId}:end`,   position: l.end,   snapKind: vertexSnapKind(eKind, 'end') })
      if ('radius' in l && 'angle_start' in l) {
        targets.push({ vertexId: `vertex:${featureId}:${entityId}:center`, position: (l as Arc).center, snapKind: 'center' })
      }
    } else if ('center' in entity && 'radius' in entity) {
      const c = entity as Circle
      targets.push({ vertexId: `vertex:${featureId}:${entityId}:center`, position: c.center, snapKind: 'center' })
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
  draggedEntityKind: string,  // kind of the entity being dragged (for registry lookup)
  draggedVertexKey: string,   // vertex key being dragged (for registry lookup)
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
      const cKind = suggestConstraint(draggedEntityKind, draggedVertexKey, t.snapKind)
      if (cKind !== null) {
        bestVertexDist = d
        bestVertex = { ...t, dist: d }
      }
    }
  }
  if (bestVertex) {
    const cKind = suggestConstraint(draggedEntityKind, draggedVertexKey, bestVertex.snapKind)!
    return { kind: 'vertex', position: bestVertex.position, constraintKind: cKind, vertexId: bestVertex.vertexId }
  }

  // Second pass: find nearest point on entity body (smaller pull zone,
  // only fires when no vertex is within its larger zone).
  let bestEntity: SnapTarget | null = null
  let bestEntityDist = entityThreshold
  for (const [entityId, entity] of Object.entries(sketch)) {
    if (isProjectedEntity(entity as Entity)) continue
    if (entityId === skipEntityId) continue
    const cKind = suggestConstraint(draggedEntityKind, draggedVertexKey, 'path')
    if (cKind === null) continue  // registry disallows path snap for this vertex
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

export function DragPlane({ featureId, sketch }: { featureId: string; sketch?: Sketch }) {
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

  // DragPlane must be at the same z-level as the sketch plane to avoid coordinate
  // distortion when the camera views at an angle. Raycasting to z=0.5 (or z=90)
  // produces world coordinates that don't match the actual sketch plane geometry,
  // causing the dragged element to shift away from the cursor.
  // Position at z=-0.001 (between DrawPlane at z=-0.002 and geometry at z=0).
  // Self-intersection blocking (dragged entity's collision geometry blocking raycasts)
  // is solved by hiding the collision geometry (HitPolyline, hit spheres, dim hit meshes) during drag.
  // This is done in EntityLines.tsx and VertexDots.tsx (isDragged) and sketch_dimensions.tsx (isDragged).

  const toLocal = (worldPt: THREE.Vector3): [number, number] => {
    if (!meshRef.current?.parent) return [worldPt.x, worldPt.y]
    // Convert world coordinates to local sketch plane coordinates by:
    // 1. Translating relative to parent (sketch plane) position
    // 2. Rotating by inverse of parent's world orientation
    const parentPos = new THREE.Vector3()
    meshRef.current.parent.getWorldPosition(parentPos)
    const q = new THREE.Quaternion()
    meshRef.current.parent.getWorldQuaternion(q)
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
      position={[0, 0, -0.001]}
      onPointerMove={(e) => {
        e.stopPropagation()
        const [x, y] = toLocal(e.point)
        setDrag({ ...drag, currentWorld: [x, y] })

        // Snap detection: vertex then entity, only for vertex drags.
        // Uses same registry (suggestConstraint) as the drawing tool snap.
        if (drag.type === 'vertex' && sketch) {
          const draggedEntity = sketch[drag.entityId]
          const draggedEntityKind = draggedEntity ? entityKindOf(draggedEntity as Entity) : 'line'
          const pw = p2w(camera)
          const snap = findSnapTarget(
            sketch, drag.featureId, drag.entityId,
            draggedEntityKind, drag.vertexKey,
            x, y,
            DRAG_SNAP_VERTEX_RADIUS_PX * pw,
            DRAG_SNAP_ENTITY_RADIUS_PX * pw,
          )
          setDragSnap(snap)

          // Alignment detection for kinda_horizontal/kinda_vertical
          if (dynamicSelection.size > 0) {
            const alignment = detectAlignmentSnap(dynamicSelection, [x, y], dynamicSelectionPositions)
            if (alignment) {
              setAlignmentSnap(alignment.point, alignment.kind, alignment.vertexId)
            } else {
              setAlignmentSnap(null, null, null)
            }
          }
        }
      }}
      onPointerUp={(e) => {
        e.stopPropagation()
        const [x, y] = toLocal(e.point)
        // Read drag and dragSnap from store directly — not from the render closure.
        // onPointerUp may fire before React re-renders after the final onPointerMove,
        // so the closure could hold stale values. getState() always returns the latest.
        const { drag: currentDrag, dragSnap: currentDragSnap } = useSketchEditorStore.getState()
        if (!currentDrag || currentDrag.featureId !== featureId) {
          setDrag(null); setDragSnap(null); setOrbitEnabled(true); return
        }
        const finalDrag = { ...currentDrag, currentWorld: [x, y] as [number, number] }
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
