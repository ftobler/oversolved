import { useRef, useMemo } from 'react'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { sanitizePointerEvent } from './pointerAbstraction'
import { sampleArc, sampleArcCCW } from '../sketch_helpers'
import { Dot } from './VertexDots'
import { DashedLine } from '../sketch_dimensions'
import { COLOR_PREVIEW } from './constants'
import { suggestConstraint } from '../../registry'
import { useAlignmentSnapEffect } from '../interaction/useAlignmentSnapEffect'
import type { Sketch } from '../../types/cad'
import { nearestPointOnEntity } from './nearestPoint'
import { randomId } from '../../utils/yamlMutations'

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

export function DrawPreview({ activeFeatureId }: { activeFeatureId?: string }) {
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const effectiveTool = activeTool ?? 'drag'
  const drawPoints = useSketchEditorStore(s => s.drawPoints)
  const drawHover = useSketchEditorStore(s => s.drawHover)
  const alignmentSnapPoint = useSketchEditorStore(s => s.alignmentSnapPoint)
  const alignmentSnapKind = useSketchEditorStore(s => s.alignmentSnapKind)

  if (activeFeatureId === null) return null
  if (effectiveTool === 'select') return null

  const previewPts = computePreviewPts(effectiveTool, drawPoints, drawHover)

  // Compute the actual endpoint position (handles snapping)
  const endpoint = drawHover

  return (
    <>
      {/* Placed points (already clicked) */}
      {drawPoints.map((pt, i) => (
        <Dot key={i} x={pt[0]} y={pt[1]} px={4} color={COLOR_PREVIEW} billboard />
      ))}
      {/* Hover cursor dot */}
      {drawHover && effectiveTool === 'point' && (
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

export function DrawPlane({ featureId, activeFeatureId, sketch, sketchGroupRef, otherSketches }: {
  featureId: string
  activeFeatureId?: string
  sketch?: Sketch
  sketchGroupRef?: React.RefObject<THREE.Group | null>
  otherSketches?: Record<string, Sketch>
}) {
  const meshRef = useRef<THREE.Mesh>(null)
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const effectiveTool = activeTool ?? 'drag'
  const drawPoints = useSketchEditorStore(s => s.drawPoints)
  const addDrawPoint = useSketchEditorStore(s => s.addDrawPoint)
  const setDrawHover = useSketchEditorStore(s => s.setDrawHover)
  const setDrawSnap = useSketchEditorStore(s => s.setDrawSnap)
  const clearDraw = useSketchEditorStore(s => s.clearDraw)
  const onMutation = useSketchEditorStore(s => s.onMutation)
  const setActiveTool = useSketchEditorStore(s => s.setActiveTool)
  const clearNormalSelection = useSketchEditorStore(s => s.clearNormalSelection)
  const hoveredVertexPosition = useSketchEditorStore(s => s.hoveredVertexPosition)
  const hoveredVertexId = useSketchEditorStore(s => s.hoveredVertexId)
  const hoveredSnapKind = useSketchEditorStore(s => s.hoveredSnapKind)
  const hoveredEntityId = useSketchEditorStore(s => s.hoveredEntityId)
  const drawHover = useSketchEditorStore(s => s.drawHover)

  useAlignmentSnapEffect(sketch, drawHover)

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

  if (featureId !== activeFeatureId) return null

  // Deselection plane: catch clicks on empty sketch space
  // Positioned far back in local z to not interfere with plane hover geometry
  if (effectiveTool === 'select' || effectiveTool === 'dimension' || effectiveTool === 'drag') {
    return (
      <mesh
        position={[0, 0, -1000]}
        onClick={(e) => { e.stopPropagation(); clearNormalSelection() }}
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

    if (effectiveTool === 'point') {
      onMutation?.({ type: 'add_entity', featureId, kind: 'point', params: [px, py] })

    } else if (effectiveTool === 'line') {
      if (pts.length === 0) {
        // First click: store point and snap info for second click
        addDrawPoint([px, py])
        if (hoveredVertexId) {
          setDrawSnap(hoveredVertexId, null)
        } else if (pathSnap && hoveredEntityId) {
          setDrawSnap(null, hoveredEntityId)
        }
      } else {
        // Second click: create line with constraint
        const state = useSketchEditorStore.getState()
        const startSnapVertexId = state.drawSnapVertexId
        const startSnapEntityRef = state.drawSnapEntityRef

        // Priority for end point: alignment > vertex > path > none
        const alignmentSnapPoint = state.alignmentSnapPoint
        const alignmentSnapKind = state.alignmentSnapKind
        const alignmentSnapVertexId = state.alignmentSnapVertexId

        // Build params and constraint for the start vertex
        const hasStartSnap = startSnapVertexId || startSnapEntityRef
        const hasEndSnap = (alignmentSnapPoint && alignmentSnapKind && alignmentSnapVertexId) ||
                          (hoveredVertexId && hoveredSnapKind) ||
                          (pathSnap && hoveredEntityId)

        if (hasStartSnap || hasEndSnap) {
          // Generate entity ID upfront so we can reference it in constraints
          const lineId = randomId(12)

          // Use add_entity_with_constraint for the start vertex
          if (startSnapVertexId) {
            onMutation?.({ type: 'add_entity_with_constraint', featureId, kind: 'line',
              params: [pts[0][0], pts[0][1], px, py], vertexKey: 'start',
              snapVertexId: startSnapVertexId, constraintKind: 'coincident', entityId: lineId })
          } else if (startSnapEntityRef) {
            onMutation?.({ type: 'add_entity_with_constraint', featureId, kind: 'line',
              params: [pts[0][0], pts[0][1], px, py], vertexKey: 'start',
              constraintKind: 'coincident', snapEntityRef: startSnapEntityRef, entityId: lineId })
          } else {
            onMutation?.({ type: 'add_entity', featureId, kind: 'line',
              params: [pts[0][0], pts[0][1], px, py] })
          }

          // Add constraint for end vertex
          if (alignmentSnapPoint && alignmentSnapKind && alignmentSnapVertexId) {
            const constraintKind = alignmentSnapKind === 'kinda_horizontal' ? 'horizontal' : 'vertical'
            onMutation?.({ type: 'add_constraint', featureId, kind: constraintKind,
              targets: [`vertex:${featureId}:${lineId}:end`, alignmentSnapVertexId] })
          } else if (hoveredVertexId && hoveredSnapKind) {
            const constraintKind = suggestConstraint('vertex', hoveredSnapKind) ?? 'coincident'
            onMutation?.({ type: 'add_constraint', featureId, kind: constraintKind,
              targets: [`vertex:${featureId}:${lineId}:end`, hoveredVertexId] })
          } else if (pathSnap && hoveredEntityId) {
            onMutation?.({ type: 'add_constraint', featureId, kind: 'coincident',
              targets: [`vertex:${featureId}:${lineId}:end`, `entity:${featureId}:*`] })
          }
        } else {
          onMutation?.({ type: 'add_entity', featureId, kind: 'line',
            params: [pts[0][0], pts[0][1], px, py] })
        }
        clearDraw()
        setActiveTool(null)
      }

    } else if (effectiveTool === 'circle') {
      if (pts.length === 0) {
        addDrawPoint([px, py])
        if (hoveredVertexId) {
          setDrawSnap(hoveredVertexId, null)
        } else if (pathSnap && hoveredEntityId) {
          setDrawSnap(null, hoveredEntityId)
        }
      } else {
        const state = useSketchEditorStore.getState()
        const centerSnapVertexId = state.drawSnapVertexId
        const centerSnapEntityRef = state.drawSnapEntityRef
        const r = Math.hypot(px - pts[0][0], py - pts[0][1])
        if (r > 0) {
          if (centerSnapVertexId || centerSnapEntityRef) {
            if (centerSnapVertexId) {
              onMutation?.({ type: 'add_entity_with_constraint', featureId, kind: 'circle',
                params: [pts[0][0], pts[0][1], r], vertexKey: 'center',
                snapVertexId: centerSnapVertexId, constraintKind: 'coincident' })
            } else {
              onMutation?.({ type: 'add_entity_with_constraint', featureId, kind: 'circle',
                params: [pts[0][0], pts[0][1], r], vertexKey: 'center',
                constraintKind: 'coincident', snapEntityRef: centerSnapEntityRef! })
            }
          } else {
            onMutation?.({ type: 'add_entity', featureId, kind: 'circle',
              params: [pts[0][0], pts[0][1], r] })
          }
        }
        clearDraw()
        setActiveTool(null)
      }

    } else if (effectiveTool === 'arc') {
      if (pts.length === 0) {
        addDrawPoint([px, py])
        if (hoveredVertexId) {
          setDrawSnap(hoveredVertexId, null)
        } else if (pathSnap && hoveredEntityId) {
          setDrawSnap(null, hoveredEntityId)
        }
      } else if (pts.length === 1) {
        addDrawPoint([px, py])
      } else {
        const cc = circumcircle(pts[0], pts[1], [px, py])
        if (cc && cc.r > 0) {
          const [aStart, aEnd] = arcAnglesFromRadiusPoint(cc.cx, cc.cy, pts[0], pts[1], [px, py])
          onMutation?.({ type: 'add_entity', featureId, kind: 'arc',
            params: [cc.cx, cc.cy, cc.r, aStart, aEnd] })
        }
        clearDraw()
        setActiveTool(null)
      }

    } else if (effectiveTool === 'rect') {
      if (pts.length === 0) {
        addDrawPoint([px, py])
        if (hoveredVertexId) {
          setDrawSnap(hoveredVertexId, null)
        } else if (pathSnap && hoveredEntityId) {
          setDrawSnap(null, hoveredEntityId)
        }
      } else {
        onMutation?.({ type: 'add_rect', featureId, p0: pts[0], p1: [px, py] })
        clearDraw()
        setActiveTool(null)
      }

    } else if (effectiveTool === 'center_rect') {
      if (pts.length === 0) {
        addDrawPoint([px, py])
        if (hoveredVertexId) {
          setDrawSnap(hoveredVertexId, null)
        } else if (pathSnap && hoveredEntityId) {
          setDrawSnap(null, hoveredEntityId)
        }
      } else {
        onMutation?.({ type: 'add_center_rect', featureId, center: pts[0], corner: [px, py] })
        clearDraw()
        setActiveTool(null)
      }

    } else if (effectiveTool === 'project') {
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
            setActiveTool(null)
          }
        }
      }
    }
  }

  // Resolve the sketch group ref: prefer explicit prop, fall back to mesh parent.
  const resolvedGroupRef: React.RefObject<THREE.Object3D | null> = sketchGroupRef ?? {
    get current() { return meshRef.current?.parent ?? null },
  }

  return (
    <mesh
      ref={meshRef}
      position={[0, 0, -0.002]}
      onPointerMove={e => {
        e.stopPropagation()
        if (e.buttons & 6) { setDrawHover(null); return }
        const sanitized = sanitizePointerEvent(e, resolvedGroupRef)
        setDrawHover(sanitized?.localPoint ?? null)
      }}
      onPointerDown={e => {
        e.stopPropagation()
        const sanitized = sanitizePointerEvent(e, resolvedGroupRef)
        if (!sanitized) return
        const [x, y] = sanitized.localPoint
        handleDown(x, y)
      }}
      onPointerOut={() => setDrawHover(null)}
    >
      <planeGeometry args={[100000, 100000]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  )
}
