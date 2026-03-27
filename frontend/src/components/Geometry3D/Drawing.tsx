import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { sampleArc } from '../sketch_helpers'
import { Dot } from './VertexDots'
import { COLOR_PREVIEW } from './constants'

/** Compute circumcircle of 3 points. Returns null if points are collinear. */
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
      return sampleArc(cc.cx, cc.cy, cc.r, aStart, aEnd)
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

  if (featureId !== activeFeatureId) return null
  if (activeTool === 'select') return null

  const previewPts = computePreviewPts(activeTool, drawPoints, drawHover)

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
    </>
  )
}

export function DrawPlane({ featureId, activeFeatureId }: { featureId: string; activeFeatureId?: string }) {
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const drawPoints = useSketchEditorStore(s => s.drawPoints)
  const addDrawPoint = useSketchEditorStore(s => s.addDrawPoint)
  const setDrawHover = useSketchEditorStore(s => s.setDrawHover)
  const clearDraw = useSketchEditorStore(s => s.clearDraw)
  const onMutation = useSketchEditorStore(s => s.onMutation)
  const setActiveTool = useSketchEditorStore(s => s.setActiveTool)

  if (featureId !== activeFeatureId) return null
  if (activeTool === 'select' || activeTool === 'dimension') return null

  const handleDown = (x: number, y: number) => {
    const pts = drawPoints

    if (activeTool === 'point') {
      onMutation?.({ type: 'add_entity', featureId, kind: 'point', params: [x, y] })
      // keep tool active for repeated point insertion

    } else if (activeTool === 'line') {
      if (pts.length === 0) {
        addDrawPoint([x, y])
      } else {
        onMutation?.({ type: 'add_entity', featureId, kind: 'line',
          params: [pts[0][0], pts[0][1], x, y] })
        clearDraw()
        setActiveTool('select')
      }

    } else if (activeTool === 'circle') {
      if (pts.length === 0) {
        addDrawPoint([x, y])
      } else {
        const r = Math.hypot(x - pts[0][0], y - pts[0][1])
        if (r > 0) {
          onMutation?.({ type: 'add_entity', featureId, kind: 'circle',
            params: [pts[0][0], pts[0][1], r] })
        }
        clearDraw()
        setActiveTool('select')
      }

    } else if (activeTool === 'arc') {
      if (pts.length === 0) {
        addDrawPoint([x, y])           // start point
      } else if (pts.length === 1) {
        addDrawPoint([x, y])           // end point
      } else {
        // pts[0]=start, pts[1]=end, [x,y]=radius point
        const cc = circumcircle(pts[0], pts[1], [x, y])
        if (cc && cc.r > 0) {
          const [aStart, aEnd] = arcAnglesFromRadiusPoint(cc.cx, cc.cy, pts[0], pts[1], [x, y])
          onMutation?.({ type: 'add_entity', featureId, kind: 'arc',
            params: [cc.cx, cc.cy, cc.r, aStart, aEnd] })
        }
        clearDraw()
        setActiveTool('select')
      }

    } else if (activeTool === 'rect') {
      if (pts.length === 0) {
        addDrawPoint([x, y])
      } else {
        onMutation?.({ type: 'add_rect', featureId, p0: pts[0], p1: [x, y] })
        clearDraw()
        setActiveTool('select')
      }

    } else if (activeTool === 'center_rect') {
      if (pts.length === 0) {
        addDrawPoint([x, y])           // first click = center
      } else {
        onMutation?.({ type: 'add_center_rect', featureId, center: pts[0], corner: [x, y] })
        clearDraw()
        setActiveTool('select')
      }
    }
  }

  return (
    <mesh
      position={[0, 0, -0.002]}
      onPointerMove={e => { e.stopPropagation(); setDrawHover([e.point.x, e.point.y]) }}
      onPointerDown={e => { e.stopPropagation(); handleDown(e.point.x, e.point.y) }}
      onPointerOut={() => setDrawHover(null)}
    >
      <planeGeometry args={[100000, 100000]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  )
}
