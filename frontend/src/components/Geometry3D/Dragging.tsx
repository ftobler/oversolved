import * as THREE from 'three'
import type { Sketch, LineSegment, Circle, Arc, PointEntity } from '../../types/cad'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'

export function DragPlane() {
  const drag = useSketchEditorStore(s => s.drag)
  const setDrag = useSketchEditorStore(s => s.setDrag)
  const setOrbitEnabled = useSketchEditorStore(s => s.setOrbitEnabled)
  const onMutation = useSketchEditorStore(s => s.onMutation)

  if (!drag) return null

  return (
    <mesh
      position={[0, 0, 90]}
      onPointerMove={(e) => {
        e.stopPropagation()
        setDrag({ ...drag, currentWorld: [e.point.x, e.point.y] })
      }}
      onPointerUp={(e) => {
        e.stopPropagation()
        if (onMutation) {
          if (drag.type === 'dim_label') {
            const pos: [number, number] = [
              drag.currentWorld[0] - drag.anchorWorld[0],
              drag.currentWorld[1] - drag.anchorWorld[1],
            ]
            onMutation({ type: 'set_constraint_pos', featureId: drag.featureId, constraintId: drag.constraintId, pos })
          } else if (drag.type === 'edge') {
            const delta: [number, number] = [
              drag.currentWorld[0] - drag.startWorld[0],
              drag.currentWorld[1] - drag.startWorld[1],
            ]
            onMutation({ type: 'move_entity', featureId: drag.featureId, entityId: drag.entityId, delta })
          } else {
            onMutation({ type: 'move_vertex', featureId: drag.featureId,
              entityId: drag.entityId, vertexKey: drag.vertexKey, to: drag.currentWorld })
          }
        }
        setDrag(null)
        setOrbitEnabled(true)
      }}
    >
      <planeGeometry args={[10000, 10000]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  )
}

/** Apply drag offset to sketch for optimistic preview.
 *  Dimension label drags (dim_label) don't affect entity geometry — the optimistic
 *  position is handled inside each dimension component via the drag store. */
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
