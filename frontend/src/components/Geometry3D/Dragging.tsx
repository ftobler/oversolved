import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import type { Sketch, LineSegment, Circle, Arc, PointEntity, Entity } from '../../types/cad'
import { isProjectedEntity } from '../../types/cad'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { Dot, VertexHighlight } from './VertexDots'
import { p2w } from '../sketch_helpers'
import { nearestPointOnEntity } from './nearestPoint'
import { COLOR_SNAP, DRAG_SNAP_VERTEX_RADIUS_PX, DRAG_SNAP_ENTITY_RADIUS_PX, POINT_HIT_PIXELS } from './constants'

// Snap kind discriminator:
//   'vertex' — cursor is close to a specific named vertex (point-to-point coincident)
//   'entity' — cursor is close to an entity body but not to a vertex (point-on-entity coincident)
// Vertex snap takes priority over entity snap at the same distance.
export type DragSnapKind = 'vertex' | 'entity'

export interface SnapTarget {
  kind: DragSnapKind
  position: [number, number]
  vertexId?: string   // set when kind === 'vertex'; format: "vertex:featureId:entityId:key"
  entityRef?: string  // set when kind === 'entity'; format: "entity:featureId:entityId"
}

/** Collect all discrete vertex positions from a sketch.
 *  Excludes projected entities and the entity currently being dragged. */
// eslint-disable-next-line react-refresh/only-export-components
export function collectVertexTargets(sketch: Sketch, featureId: string, skipEntityId: string): SnapTarget[] {
  const targets: SnapTarget[] = []
  for (const [entityId, entity] of Object.entries(sketch)) {
    if (isProjectedEntity(entity as Entity)) continue
    if (entityId === skipEntityId) continue

    if ('start' in entity && 'end' in entity) {
      const l = entity as LineSegment | Arc
      targets.push({ kind: 'vertex', vertexId: `vertex:${featureId}:${entityId}:start`, position: l.start })
      targets.push({ kind: 'vertex', vertexId: `vertex:${featureId}:${entityId}:end`, position: l.end })
      if ('radius' in l && 'angle_start' in l) {
        targets.push({ kind: 'vertex', vertexId: `vertex:${featureId}:${entityId}:center`, position: (l as Arc).center })
      }
    } else if ('center' in entity && 'radius' in entity) {
      const c = entity as Circle
      targets.push({ kind: 'vertex', vertexId: `vertex:${featureId}:${entityId}:center`, position: c.center })
    } else if ('x' in entity) {
      const p = entity as PointEntity
      targets.push({ kind: 'vertex', vertexId: `vertex:${featureId}:${entityId}:xy`, position: [p.x, p.y] })
    }
  }
  return targets
}

/** Find the best snap target.
 *  Vertex snap uses a larger pull radius than entity snap, mirroring how
 *  POINT_HIT_PIXELS > HIT_PIXELS in click detection. This ensures dragging
 *  near an endpoint always snaps to the vertex rather than the entity body. */
// eslint-disable-next-line react-refresh/only-export-components
export function findSnapTarget(
  sketch: Sketch,
  featureId: string,
  skipEntityId: string,
  x: number,
  y: number,
  vertexThreshold: number,  // world units, for point-to-point snap (larger)
  entityThreshold: number,  // world units, for point-on-entity snap (smaller)
): SnapTarget | null {
  // First pass: find nearest vertex within its (larger) pull zone
  let bestVertex: SnapTarget | null = null
  let bestVertexDist = vertexThreshold
  for (const t of collectVertexTargets(sketch, featureId, skipEntityId)) {
    const d = Math.hypot(t.position[0] - x, t.position[1] - y)
    if (d < bestVertexDist) {
      bestVertexDist = d
      bestVertex = t
    }
  }
  if (bestVertex) return bestVertex

  // Second pass: find nearest point on entity body (smaller pull zone, only
  // fires when no vertex is within its larger zone)
  let bestEntity: SnapTarget | null = null
  let bestEntityDist = entityThreshold
  for (const [entityId, entity] of Object.entries(sketch)) {
    if (isProjectedEntity(entity as Entity)) continue
    if (entityId === skipEntityId) continue
    const result = nearestPointOnEntity(x, y, entity as Entity)
    if (result && result.distance < bestEntityDist) {
      bestEntityDist = result.distance
      bestEntity = {
        kind: 'entity',
        position: result.position as [number, number],
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
  const { camera } = useThree()

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

        // Snap detection: vertex then entity, only for vertex drags
        if (drag.type === 'vertex' && sketch) {
          const pw = p2w(camera)
          const snap = findSnapTarget(
            sketch, drag.featureId, drag.entityId, x, y,
            DRAG_SNAP_VERTEX_RADIUS_PX * pw,
            DRAG_SNAP_ENTITY_RADIUS_PX * pw,
          )
          setDragSnap(snap)
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
            } else if (currentDragSnap?.kind === 'vertex') {
              onMutation({
                type: 'move_vertex_with_constraint',
                featureId: finalDrag.featureId,
                entityId: finalDrag.entityId,
                vertexKey: finalDrag.vertexKey,
                to: currentDragSnap.position,
                constraintKind: 'coincident',
                snapVertexId: currentDragSnap.vertexId,
              })
            } else if (currentDragSnap?.kind === 'entity') {
              onMutation({
                type: 'move_vertex_with_constraint',
                featureId: finalDrag.featureId,
                entityId: finalDrag.entityId,
                vertexKey: finalDrag.vertexKey,
                to: currentDragSnap.position,
                constraintKind: 'coincident',
                snapEntityRef: currentDragSnap.entityRef,
              })
            } else {
              onMutation({ type: 'move_vertex', featureId: finalDrag.featureId,
                entityId: finalDrag.entityId, vertexKey: finalDrag.vertexKey, to: finalDrag.currentWorld })
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
