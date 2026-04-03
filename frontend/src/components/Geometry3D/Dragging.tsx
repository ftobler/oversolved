import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { Sketch, LineSegment, Circle, Arc, PointEntity } from '../../types/cad'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'

export function DragPlane({ featureId }: { featureId: string }) {
  const meshRef = useRef<THREE.Mesh>(null)
  const drag = useSketchEditorStore(s => s.drag)
  const setDrag = useSketchEditorStore(s => s.setDrag)
  const setOrbitEnabled = useSketchEditorStore(s => s.setOrbitEnabled)
  const onMutation = useSketchEditorStore(s => s.onMutation)

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
    const cancel = () => { setDrag(null); setOrbitEnabled(true) }
    window.addEventListener('pointerup', cancel)
    return () => window.removeEventListener('pointerup', cancel)
  }, [drag, featureId, setDrag, setOrbitEnabled])

  if (!drag) return null

  return (
    <mesh
      ref={meshRef}
      position={[0, 0, -0.001]}
      onPointerMove={(e) => {
        e.stopPropagation()
        const [x, y] = toLocal(e.point)
        setDrag({ ...drag, currentWorld: [x, y] })
      }}
      onPointerUp={(e) => {
        e.stopPropagation()
        const [x, y] = toLocal(e.point)
        const finalDrag = { ...drag, currentWorld: [x, y] as [number, number] }
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
              setOrbitEnabled(true)
              return
            }
            if (finalDrag.type === 'edge') {
              const delta: [number, number] = [
                finalDrag.currentWorld[0] - finalDrag.startWorld[0],
                finalDrag.currentWorld[1] - finalDrag.startWorld[1],
              ]
              onMutation({ type: 'move_entity', featureId: finalDrag.featureId, entityId: finalDrag.entityId, delta })
            } else {
              onMutation({ type: 'move_vertex', featureId: finalDrag.featureId,
                entityId: finalDrag.entityId, vertexKey: finalDrag.vertexKey, to: finalDrag.currentWorld })
            }
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
