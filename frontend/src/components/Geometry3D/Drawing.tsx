import { useRef, useMemo, useEffect } from 'react'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { sampleArc, sampleArcCCW } from '../sketch_helpers'
import { Dot } from './VertexDots'
import { DashedLine } from '../sketch_dimensions'
import { COLOR_PREVIEW } from './constants'
import { suggestConstraint, detectAlignmentSnap } from '../../registry'
import type { Sketch, LineSegment, Circle, Arc, PointEntity } from '../../types/cad'
import { nearestPointOnEntity } from './nearestPoint'

// Compute circumcircle of 3 points. Returns null if points are collinear.
// eslint-disable-next-line react-refresh/only-export-components
export function circumcircle(p1: [number, number], p2: [number, number], p3: [number, number]): { cx: number; cy: number; r: number } | null {
  const ax = p1[0], ay = p1[1]
  const bx = p2[0], by = p2[1]
  const cx = p3[0], cy = p3[1]
  const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(D) < 1e-10) return null
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D
  const r = Math.hypot(ax - ux, ay - uy)
  return { cx: ux, cy: uy, r }
}

/** Given arc start and end angles (degrees) and a radius point, determine the CCW arc.
 *  Returns [aStart, aEnd] such that going CCW from aStart reaches aEnd.
 *  The radius point determines which arc (short or long) was intended. */
// eslint-disable-next-line react-refresh/only-export-components
export function arcAnglesFromRadiusPoint(
  cx: number, cy: number,
  start: [number, number], end: [number, number], radiusPt: [number, number]
): [number, number] {
  const aStart = Math.atan2(start[1] - cy, start[0] - cx) * (180 / Math.PI)
  const aEnd = Math.atan2(end[1] - cy, end[0] - cx) * (180 / Math.PI)
  const aRadius = Math.atan2(radiusPt[1] - cy, radiusPt[0] - cx) * (180 / Math.PI)

  // Normalize all to [0, 360)
  const norm = (a: number) => ((a % 360) + 360) % 360
  const s = norm(aStart)
  const e = norm(aEnd)
  const rp = norm(aRadius)

  // CCW span from s to e
  const spanCCW = ((e - s) + 360) % 360

  // Is the radius point in the CCW arc from s to e?
  const rpInCCW = ((rp - s) + 360) % 360 < spanCCW

  if (rpInCCW) {
    // Short/long CCW arc contains the radius point — use it as-is
    return [aStart, aEnd]
  } else {
    // Radius point is in the CW arc — flip to get CCW arc that contains it
    return [aEnd, aStart]
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export function computePreviewPts(
  tool: string,
  pts: [number, number][],
  hover: [number, number] | null,
): [number, number, number][] | null {
  const h = hover
  if (tool === 'line' && pts.length === 1 && h) {
    return [[pts[0][0], pts[0][1], 0], [h[0], h[1], 0]]
  }
  if (tool === 'circle' && pts.length === 1 && h) {
    const r = Math.hypot(h[0] - pts[0][0], h[1] - pts[0][1])
    return sampleArc(pts[0][0], pts[0][1], r, 0, 0)
  }
  if (tool === 'arc' && pts.length === 2 && h) {
    // pts[0]=start, pts[1]=end, h=radius point — show live arc preview
    const cc = circumcircle(pts[0], pts[1], h)
    if (cc) {
      const [aStart, aEnd] = arcAnglesFromRadiusPoint(cc.cx, cc.cy, pts[0], pts[1], h)
      return sampleArcCCW(cc.cx, cc.cy, cc.r, aStart, aEnd)
    }
    // Collinear — just show chord
    return [[pts[0][0], pts[0][1], 0], [pts[1][0], pts[1][1], 0]]
  }
  if (tool === 'arc' && pts.length === 1 && h) {
    // Show chord from start to hover (indicating end point placement)
    return [[pts[0][0], pts[0][1], 0], [h[0], h[1], 0]]
  }
  if (tool === 'rect' && pts.length === 1 && h) {
    const [x0, y0] = pts[0]
    const [x1, y1] = h
    return [[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0], [x0, y0, 0]]
  }
  if (tool === 'center_rect' && pts.length === 1 && h) {
    const [cx, cy] = pts[0]
    const [x, y] = h
    const dx = x - cx, dy = y - cy
    // Symmetric rectangle around center
    const x0 = cx - dx, x1 = cx + dx
    const y0 = cy - dy, y1 = cy + dy
    return [[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0], [x0, y0, 0]]
  }
  return null
}

export function DrawPreview({ featureId, activeFeatureId }: { featureId: string; activeFeatureId?: string }) {
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const drawPoints = useSketchEditorStore(s => s.drawPoints)
  const drawHover = useSketchEditorStore(s => s.drawHover)
  const alignmentSnapPoint = useSketchEditorStore(s => s.alignmentSnapPoint)
  const alignmentSnapKind = useSketchEditorStore(s => s.alignmentSnapKind)

  if (featureId !== activeFeatureId) return null
  if (activeTool === 'select') return null

  const previewPts = computePreviewPts(activeTool, drawPoints, drawHover)

  // Compute the actual endpoint position (handles snapping)
  const endpoint = drawHover

  return (
    <>
      {/* Placed points (already clicked) */}
      {drawPoints.map((pt, i) => (
        <Dot key={i} x={pt[0]} y={pt[1]} px={4} color={COLOR_PREVIEW} billboard />
      ))}
      {/* Hover cursor dot */}
      {drawHover && activeTool === 'point' && (
        <Dot x={drawHover[0]} y={drawHover[1]} px={4} color={COLOR_PREVIEW} billboard />
      )}
      {/* Preview line/shape */}
      {previewPts && <Line points={previewPts} color={COLOR_PREVIEW} lineWidth={1} />}
      {/* Alignment guide lines */}
      {alignmentSnapPoint && endpoint && alignmentSnapKind && (
        <DashedLine
          points={[
            [alignmentSnapPoint[0], alignmentSnapPoint[1], 0],
            [endpoint[0], endpoint[1], 0],
          ]}
          color={COLOR_PREVIEW}
          lineWidth={1}
        />
      )}
    </>
  )
}

export function DrawPlane({ featureId, activeFeatureId, sketch, otherSketches }: { featureId: string; activeFeatureId?: string; sketch?: Sketch; otherSketches?: Record<string, Sketch> }) {
  const meshRef = useRef<THREE.Mesh>(null)
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const drawPoints = useSketchEditorStore(s => s.drawPoints)
  const addDrawPoint = useSketchEditorStore(s => s.addDrawPoint)
  const setDrawHover = useSketchEditorStore(s => s.setDrawHover)
  const clearDraw = useSketchEditorStore(s => s.clearDraw)
  const onMutation = useSketchEditorStore(s => s.onMutation)
  const setActiveTool = useSketchEditorStore(s => s.setActiveTool)
  const clearSelection = useSketchEditorStore(s => s.clearSelection)
  const hoveredVertexPosition = useSketchEditorStore(s => s.hoveredVertexPosition)
  const hoveredVertexId = useSketchEditorStore(s => s.hoveredVertexId)
  const hoveredSnapKind = useSketchEditorStore(s => s.hoveredSnapKind)
  const hoveredEntityId = useSketchEditorStore(s => s.hoveredEntityId)
  const dynamicSelection = useSketchEditorStore(s => s.dynamicSelection)
  const setAlignmentSnap = useSketchEditorStore(s => s.setAlignmentSnap)

  const drawHover = useSketchEditorStore(s => s.drawHover)

  const pathSnap = useMemo(() => {
    // Use hovered entity (not vertex) for path snapping
    if (!sketch || !drawHover || !hoveredEntityId) return null
    if (hoveredEntityId.startsWith('vertex:')) return null  // vertex hover takes priority
    
    // Parse hoveredEntityId: "entity:featureId:entityId"
    const parts = hoveredEntityId.split(':')
    if (parts.length < 3 || parts[0] !== 'entity') return null
    const entityId = parts[2]
    const entity = sketch[entityId]
    if (!entity) return null
    
    const [hx, hy] = drawHover
    return nearestPointOnEntity(hx, hy, entity)
  }, [sketch, drawHover, hoveredEntityId])

  // Build map of dynamic selection positions for alignment detection
  const dynamicSelectionPositions = useMemo(() => {
    const pos = new Map<string, [number, number]>()
    if (!sketch) return pos
    for (const id of dynamicSelection) {
      if (id.startsWith('vertex:')) {
        // Format: vertex:featureId:entityId:key
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
        // Use entity center for entity references
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

  // Detect alignment snap when drawing with dynamic selection
  useEffect(() => {
    if (!drawHover || dynamicSelection.size === 0) {
      setAlignmentSnap(null, null, null)
      return
    }

    const alignment = detectAlignmentSnap(dynamicSelection, drawHover, dynamicSelectionPositions)
    if (alignment) {
      setAlignmentSnap(alignment.point, alignment.kind, alignment.vertexId)
    } else {
      setAlignmentSnap(null, null, null)
    }
  }, [drawHover, dynamicSelection, dynamicSelectionPositions, setAlignmentSnap])

  if (featureId !== activeFeatureId) return null

  // Deselection plane: catch clicks on empty sketch space
  // Positioned far back in local z to not interfere with plane hover geometry
  if (activeTool === 'select' || activeTool === 'dimension') {
    return (
      <mesh
        position={[0, 0, -1000]}
        onClick={(e) => { e.stopPropagation(); clearSelection() }}
        onPointerOut={() => {}} // prevent propagation of pointer events
      >
        <planeGeometry args={[100000, 100000]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    )
  }

  const handleDown = (x: number, y: number) => {
    // Snap priority: vertex > path
    const [px, py] = hoveredVertexPosition ?? pathSnap?.position ?? [x, y]
    const pts = drawPoints

    if (activeTool === 'point') {
      onMutation?.({ type: 'add_entity', featureId, kind: 'point', params: [px, py] })
      // keep tool active for repeated point insertion

    } else if (activeTool === 'line') {
      if (pts.length === 0) {
        // First click: create point with constraint if snapped
        if (hoveredVertexId && hoveredSnapKind) {
          onMutation?.({ type: 'add_point_with_constraint', featureId, params: [px, py],
            snapVertexId: hoveredVertexId, constraintKind: 'coincident' })
          addDrawPoint([px, py])  // store coords for line params
        } else if (pathSnap && hoveredEntityId) {
          onMutation?.({ type: 'add_point_with_constraint', featureId, params: [px, py],
            snapEntityRef: hoveredEntityId, constraintKind: 'coincident' })
          addDrawPoint([px, py])
        } else {
          // No snap: store plain point
          addDrawPoint([px, py])
        }
      } else {
        // Second click: create line with constraint if snapped
        // Priority: alignment snap > vertex snap > path snap > none
        const alignmentSnapPoint = useSketchEditorStore.getState().alignmentSnapPoint
        const alignmentSnapKind = useSketchEditorStore.getState().alignmentSnapKind
        const alignmentSnapVertexId = useSketchEditorStore.getState().alignmentSnapVertexId

        if (alignmentSnapPoint && alignmentSnapKind && alignmentSnapVertexId) {
          const constraintKind = alignmentSnapKind === 'kinda_horizontal' ? 'horizontal' : 'vertical'
          onMutation?.({ type: 'add_entity_with_constraint', featureId, kind: 'line',
            params: [pts[0][0], pts[0][1], px, py], vertexKey: 'end', snapVertexId: alignmentSnapVertexId, constraintKind })
        } else if (hoveredVertexId && hoveredSnapKind) {
          const constraintKind = suggestConstraint('vertex', hoveredSnapKind) ?? 'coincident'
          onMutation?.({ type: 'add_entity_with_constraint', featureId, kind: 'line',
            params: [pts[0][0], pts[0][1], px, py], vertexKey: 'end', snapVertexId: hoveredVertexId, constraintKind })
        } else if (pathSnap && hoveredEntityId) {
          // Path snap: create constraint with the entity directly (not a vertex)
          // hoveredEntityId format: "entity:featureId:entityId"
          onMutation?.({ type: 'add_entity_with_constraint', featureId, kind: 'line',
            params: [pts[0][0], pts[0][1], px, py], vertexKey: 'end', constraintKind: 'coincident', snapEntityRef: hoveredEntityId })
        } else {
          onMutation?.({ type: 'add_entity', featureId, kind: 'line',
            params: [pts[0][0], pts[0][1], px, py] })
        }
        clearDraw()
        setActiveTool('select')
      }

    } else if (activeTool === 'circle') {
      if (pts.length === 0) {
        // First click: create point with constraint if snapped
        if (hoveredVertexId && hoveredSnapKind) {
          onMutation?.({ type: 'add_point_with_constraint', featureId, params: [px, py],
            snapVertexId: hoveredVertexId, constraintKind: 'coincident' })
          addDrawPoint([px, py])
        } else if (pathSnap && hoveredEntityId) {
          onMutation?.({ type: 'add_point_with_constraint', featureId, params: [px, py],
            snapEntityRef: hoveredEntityId, constraintKind: 'coincident' })
          addDrawPoint([px, py])
        } else {
          addDrawPoint([px, py])
        }
      } else {
        const r = Math.hypot(px - pts[0][0], py - pts[0][1])
        if (r > 0) {
          onMutation?.({ type: 'add_entity', featureId, kind: 'circle',
            params: [pts[0][0], pts[0][1], r] })
        }
        clearDraw()
        setActiveTool('select')
      }

    } else if (activeTool === 'arc') {
      if (pts.length === 0) {
        // First click: create point with constraint if snapped
        if (hoveredVertexId && hoveredSnapKind) {
          onMutation?.({ type: 'add_point_with_constraint', featureId, params: [px, py],
            snapVertexId: hoveredVertexId, constraintKind: 'coincident' })
          addDrawPoint([px, py])
        } else if (pathSnap && hoveredEntityId) {
          onMutation?.({ type: 'add_point_with_constraint', featureId, params: [px, py],
            snapEntityRef: hoveredEntityId, constraintKind: 'coincident' })
          addDrawPoint([px, py])
        } else {
          addDrawPoint([px, py])
        }
      } else if (pts.length === 1) {
        // Second click: end point
        addDrawPoint([px, py])
      } else {
        // Third click: create arc
        const cc = circumcircle(pts[0], pts[1], [px, py])
        if (cc && cc.r > 0) {
          const [aStart, aEnd] = arcAnglesFromRadiusPoint(cc.cx, cc.cy, pts[0], pts[1], [px, py])
          onMutation?.({ type: 'add_entity', featureId, kind: 'arc',
            params: [cc.cx, cc.cy, cc.r, aStart, aEnd] })
        }
        clearDraw()
        setActiveTool('select')
      }

    } else if (activeTool === 'rect') {
      if (pts.length === 0) {
        // First click: create point with constraint if snapped
        if (hoveredVertexId && hoveredSnapKind) {
          onMutation?.({ type: 'add_point_with_constraint', featureId, params: [px, py],
            snapVertexId: hoveredVertexId, constraintKind: 'coincident' })
          addDrawPoint([px, py])
        } else if (pathSnap && hoveredEntityId) {
          onMutation?.({ type: 'add_point_with_constraint', featureId, params: [px, py],
            snapEntityRef: hoveredEntityId, constraintKind: 'coincident' })
          addDrawPoint([px, py])
        } else {
          addDrawPoint([px, py])
        }
      } else {
        onMutation?.({ type: 'add_rect', featureId, p0: pts[0], p1: [px, py] })
        clearDraw()
        setActiveTool('select')
      }

    } else if (activeTool === 'center_rect') {
      if (pts.length === 0) {
        // First click: create point with constraint if snapped (this is the center)
        if (hoveredVertexId && hoveredSnapKind) {
          onMutation?.({ type: 'add_point_with_constraint', featureId, params: [px, py],
            snapVertexId: hoveredVertexId, constraintKind: 'coincident' })
          addDrawPoint([px, py])
        } else if (pathSnap && hoveredEntityId) {
          onMutation?.({ type: 'add_point_with_constraint', featureId, params: [px, py],
            snapEntityRef: hoveredEntityId, constraintKind: 'coincident' })
          addDrawPoint([px, py])
        } else {
          addDrawPoint([px, py])
        }
      } else {
        onMutation?.({ type: 'add_center_rect', featureId, center: pts[0], corner: [px, py] })
        clearDraw()
        setActiveTool('select')
      }

    } else if (activeTool === 'project') {
      if (hoveredEntityId && hoveredEntityId.startsWith('entity:')) {
        const parts = hoveredEntityId.split(':')
        if (parts.length >= 3) {
          const sourceFeatureId = parts[1]
          const sourceEntityId = parts[2]
          if (sourceFeatureId !== featureId) {
            const source = `@${sourceFeatureId}/${sourceEntityId}`
            let kind = 'projected_line'
            const entity = (otherSketches?.[sourceFeatureId] ?? sketch)?.[sourceEntityId]
            if (entity) {
              if ('radius' in entity && 'angle_start' in entity) {
                kind = 'projected_arc'
              } else if ('radius' in entity) {
                kind = 'projected_circle'
              } else if ('x' in entity) {
                kind = 'projected_point'
              }
            }
            onMutation?.({ type: 'add_projected_entity', featureId, kind, source })
            setActiveTool('select')
          }
        }
      }
    }
  }

  const toLocal = (worldPt: THREE.Vector3): [number, number] => {
    if (!meshRef.current?.parent) return [worldPt.x, worldPt.y]
    const parentPos = new THREE.Vector3()
    meshRef.current.parent.getWorldPosition(parentPos)
    const q = new THREE.Quaternion()
    meshRef.current.parent.getWorldQuaternion(q)
    const local = worldPt.clone().sub(parentPos).applyQuaternion(q.invert())
    return [local.x, local.y]
  }

  return (
    <mesh
      ref={meshRef}
      position={[0, 0, -0.002]}
      onPointerMove={e => { e.stopPropagation(); if (e.buttons & 6) { setDrawHover(null); return }; setDrawHover(toLocal(e.point)) }}
      onPointerDown={e => { e.stopPropagation(); const [x, y] = toLocal(e.point); handleDown(x, y) }}
      onPointerOut={() => setDrawHover(null)}
    >
      <planeGeometry args={[100000, 100000]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  )
}
