import { useRef, useMemo } from 'react'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { sanitizePointerEvent } from './pointerAbstractionAdapters'
import { sampleArc, sampleArcCCW } from '../sketch_helpers'
import { Dot } from './VertexDots'
import { DashedLine } from '../sketch_dimensions'
import { COLOR_PREVIEW } from './constants'
import { useAlignmentSnapEffect } from '../interaction/useAlignmentSnapEffect'
import type { Sketch } from '../../types/cad'
import { nearestPointOnEntity } from './nearestPoint'
import { randomId } from '../../utils/yamlMutations'
import { computeDrawClick } from './drawLogic'
import type { DrawSnapState } from './drawLogic'

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

  const norm = (a: number) => ((a % 360) + 360) % 360
  const s = norm(aStart)
  const e = norm(aEnd)
  const rp = norm(aRadius)

  const spanCCW = ((e - s) + 360) % 360
  const rpInCCW = ((rp - s) + 360) % 360 < spanCCW

  if (rpInCCW) {
    return [aStart, aEnd]
  } else {
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
    const cc = circumcircle(pts[0], pts[1], h)
    if (cc) {
      const [aStart, aEnd] = arcAnglesFromRadiusPoint(cc.cx, cc.cy, pts[0], pts[1], h)
      return sampleArcCCW(cc.cx, cc.cy, cc.r, aStart, aEnd)
    }
    return [[pts[0][0], pts[0][1], 0], [pts[1][0], pts[1][1], 0]]
  }
  if (tool === 'arc' && pts.length === 1 && h) {
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
  const endpoint = drawHover

  return (
    <>
      {drawPoints.map((pt, i) => (
        <Dot key={i} x={pt[0]} y={pt[1]} px={4} color={COLOR_PREVIEW} billboard />
      ))}
      {drawHover && effectiveTool === 'point' && (
        <Dot x={drawHover[0]} y={drawHover[1]} px={4} color={COLOR_PREVIEW} billboard />
      )}
      {previewPts && <Line points={previewPts} color={COLOR_PREVIEW} lineWidth={1} />}
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

  const drawLastPoint = drawPoints.length > 0 ? drawPoints[drawPoints.length - 1] : null
  useAlignmentSnapEffect(sketch, drawHover, drawLastPoint)

  const pathSnap = useMemo(() => {
    if (!sketch || !drawHover || !hoveredEntityId) return null
    if (hoveredEntityId.startsWith('vertex:')) return null

    const parts = hoveredEntityId.split(':')
    if (parts.length < 3 || parts[0] !== 'entity') return null
    const entityId = parts[2]
    const entity = sketch[entityId]
    if (!entity) return null

    const [hx, hy] = drawHover
    return nearestPointOnEntity(hx, hy, entity)
  }, [sketch, drawHover, hoveredEntityId])

  if (featureId !== activeFeatureId) return null

  if (effectiveTool === 'select' || effectiveTool === 'dimension' || effectiveTool === 'drag') {
    return (
      <mesh
        position={[0, 0, -1000]}
        onClick={(e) => { e.stopPropagation(); clearNormalSelection() }}
        onPointerOut={() => {}}
      >
        <planeGeometry args={[100000, 100000]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    )
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

        // Read alignment snap state imperatively -- set reactively by useAlignmentSnapEffect
        const state = useSketchEditorStore.getState()
        const snap: DrawSnapState = {
          hoveredVertexId,
          hoveredVertexPosition,
          hoveredSnapKind,
          hoveredEntityId,
          pathSnapPosition: pathSnap?.position ?? null,
          pathSnapEntityRef: pathSnap ? hoveredEntityId : null,
          drawSnapVertexId: state.drawSnapVertexId,
          drawSnapEntityRef: state.drawSnapEntityRef,
          alignmentSnapPoint: state.alignmentSnapPoint,
          alignmentSnapKind: state.alignmentSnapKind,
          alignmentSnapVertexId: state.alignmentSnapVertexId,
        }

        const result = computeDrawClick(
          effectiveTool,
          drawPoints,
          [x, y],
          snap,
          featureId,
          () => randomId(12),
          sketch as Record<string, import('../../types/cad').Entity> | undefined,
          otherSketches as Record<string, Record<string, import('../../types/cad').Entity>> | undefined,
        )

        for (const m of result.mutations) {
          onMutation?.(m)
        }

        if (result.clearTool) {
          // Second click or single-click completion: clear draw state and tool
          clearDraw()
          setActiveTool(null)
        } else if (result.nextDrawPoints !== null) {
          // Replace draw points in place (preserves drawSnap for intermediate arc clicks)
          useSketchEditorStore.setState({ drawPoints: result.nextDrawPoints })
        }

        if (result.nextDrawSnap !== null) {
          setDrawSnap(result.nextDrawSnap.vertexId, result.nextDrawSnap.entityRef)
        }
      }}
      onPointerOut={() => setDrawHover(null)}
    >
      <planeGeometry args={[100000, 100000]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  )
}
