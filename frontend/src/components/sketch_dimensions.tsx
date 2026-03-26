import { useRef, useState, useCallback, useEffect } from 'react'
import { Line, Html } from '@react-three/drei'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Sketch, Constraints, Entity } from '../types/cad'
import { useSketchEditorStore } from '../stores/sketchEditorStore'
import {
  COLOR_CONSTRAINT, p2w, ARROW_SHAPE, sampleArc, getEntityBounds,
  ICON_SIZE, ICON_COLS, getIconUrl,
} from './sketch_helpers'

/** Optional interactive context for dimension components.
 *  When provided, hover highlights entities, click opens an edit prompt,
 *  and pointer-down initiates a drag to reposition the label. */
export interface DimInteraction {
  featureId: string
  entityId: string
  constraintId: string
  promptLabel: string
}

/** Filled triangle arrowhead with constant pixel size regardless of zoom. */
export function Arrowhead({ tip, from, px, color }: { tip: [number, number]; from: [number, number]; px: number; color: string }) {
  const meshRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0])
  useFrame(() => {
    if (meshRef.current) {
      const s = px * p2w(camera)
      meshRef.current.scale.set(s, s, 1)
    }
  })
  return (
    <mesh ref={meshRef} position={[tip[0], tip[1], 0]} rotation={[0, 0, angle]}>
      <shapeGeometry args={[ARROW_SHAPE]} />
      <meshBasicMaterial color={color} side={THREE.DoubleSide} />
    </mesh>
  )
}

/** Line with dash/gap sizes in pixels, constant regardless of zoom. */
export function DashedLine({ points, color, lineWidth, dashPx = 7.5, gapPx = 4.5, onPointerOver, onPointerOut }: {
  points: [number, number, number][]
  color: string
  lineWidth: number
  dashPx?: number
  gapPx?: number
  onPointerOver?: (e: { stopPropagation: () => void }) => void
  onPointerOut?: () => void
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lineRef = useRef<any>(null)
  const { camera } = useThree()
  useFrame(() => {
    const mat = lineRef.current?.material
    if (!mat) return
    const scale = p2w(camera)
    mat.dashSize = dashPx * scale
    mat.gapSize = gapPx * scale
  })
  return <Line ref={lineRef} points={points} color={color} lineWidth={lineWidth} dashed dashSize={0.01} gapSize={0.005} onPointerOver={onPointerOver} onPointerOut={onPointerOut} />
}

// ---------------------------------------------------------------------------
// Constraint symbol tile (read-only, used by Sketch3D / Visualizer)
// ---------------------------------------------------------------------------

function ConstraintTile({ url, id }: { url: string; id: string }) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      key={id}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: ICON_SIZE,
        height: ICON_SIZE,
        background: hovered ? '#ffffff' : '#3e3e3e',
        borderRadius: 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <img
        src={url}
        width={ICON_SIZE - 4}
        height={ICON_SIZE - 4}
        style={{ filter: hovered ? 'invert(0)' : 'invert(1) sepia(1) saturate(5) hue-rotate(5deg)', opacity: hovered ? 1 : 0.9 }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared interaction helpers
// ---------------------------------------------------------------------------

function useDimInteraction(cid: string, value: number, interaction: DimInteraction | undefined, validatePositive = true) {
  const setHoveredConstraintEntities = useSketchEditorStore(s => s.setHoveredConstraintEntities)
  const drag = useSketchEditorStore(s => s.drag)
  const [hovered, setHovered] = useState(false)

  // Suppress the click that the browser fires on the label mesh after a drag.
  // When the pointer moves during a dim_label drag we set this flag; the next
  // click clears it and returns early so the edit prompt is not shown.
  const dragMoved = useRef(false)
  useEffect(() => {
    if (drag?.type === 'dim_label' && drag.constraintId === cid) {
      const moved = drag.currentWorld[0] !== drag.startWorld[0]
        || drag.currentWorld[1] !== drag.startWorld[1]
      if (moved) dragMoved.current = true
    }
  }, [drag, cid])

  const onOver = useCallback((ev: { stopPropagation: () => void }) => {
    ev.stopPropagation()
    setHovered(true)
    if (interaction) setHoveredConstraintEntities(new Set([interaction.entityId]))
  }, [interaction, setHoveredConstraintEntities])
  const onOut = useCallback(() => {
    setHovered(false)
    if (interaction) setHoveredConstraintEntities(new Set())
  }, [interaction, setHoveredConstraintEntities])
  const onClick = useCallback((ev: { stopPropagation: () => void; clientX: number; clientY: number }) => {
    if (dragMoved.current) { dragMoved.current = false; return }
    if (!interaction) return
    ev.stopPropagation()
    useSketchEditorStore.getState().openDialog({
      position: [ev.clientX, ev.clientY],
      label: interaction.promptLabel,
      defaultValue: String(value),
      onConfirm: (input) => {
        const val = parseFloat(input)
        if (isNaN(val) || (validatePositive && val <= 0)) return
        useSketchEditorStore.getState().onMutation?.({ type: 'set_constraint_value', featureId: interaction.featureId, constraintId: cid, value: val })
      },
    })
  }, [interaction, cid, value, validatePositive])
  // Called at the start of each pointer-down so a fresh drag begins with the flag clear.
  const resetDragMoved = useCallback(() => { dragMoved.current = false }, [])

  const color = hovered ? '#ffffff' : COLOR_CONSTRAINT
  return { hovered, color, onOver, onOut, onClick, resetDragMoved }
}

/** Returns the active dragged label position for this constraint (if being dragged), else null. */
function useActiveLabelDrag(cid: string): [number, number] | null {
  const drag = useSketchEditorStore(s => s.drag)
  if (drag?.type === 'dim_label' && drag.constraintId === cid) {
    return drag.currentWorld
  }
  return null
}

// ---------------------------------------------------------------------------
// Dimension components (exported — used by both Sketch3D and Geometry3D)
// ---------------------------------------------------------------------------

export function LinearDimension({ cid, dim, dimOffset, interaction }: {
  cid: string
  dim: { kind: string; p1: [number, number]; p2: [number, number]; normal: [number, number]; value: number; pos?: [number, number] }
  dimOffset: number
  interaction?: DimInteraction
}) {
  const { color, onOver, onOut, onClick, resetDragMoved } = useDimInteraction(cid, dim.value, interaction)
  const activeDragPos = useActiveLabelDrag(cid)
  const meshRef = useRef<THREE.Mesh>(null)
  const setDrag = useSketchEditorStore(s => s.setDrag)
  const setOrbitEnabled = useSketchEditorStore(s => s.setOrbitEnabled)
  const { camera } = useThree()
  useFrame(() => {
    if (meshRef.current) meshRef.current.scale.setScalar(30 * p2w(camera))
  })

  const [x1, y1] = dim.p1, [x2, y2] = dim.p2
  const nx = dim.normal[0], ny = dim.normal[1]
  const nlen = Math.sqrt(nx * nx + ny * ny) || 1
  const unx = nx / nlen, uny = ny / nlen

  // Anchor = midpoint of the two measured points.
  const anchorX = (x1 + x2) / 2, anchorY = (y1 + y2) / 2

  // Effective label offset: active drag overrides stored pos, which overrides default.
  const effectivePos: [number, number] | undefined = activeDragPos
    ? [activeDragPos[0] - anchorX, activeDragPos[1] - anchorY]
    : dim.pos

  let labelX: number, labelY: number, d1x: number, d1y: number, d2x: number, d2y: number

  if (effectivePos) {
    const [ox, oy] = effectivePos
    labelX = anchorX + ox
    labelY = anchorY + oy
    // Project pos onto normal direction to get the dimension-line perpendicular offset.
    const perpOff = ox * unx + oy * uny
    d1x = x1 + unx * perpOff; d1y = y1 + uny * perpOff
    d2x = x2 + unx * perpOff; d2y = y2 + uny * perpOff
  } else {
    d1x = x1 + unx * dimOffset; d1y = y1 + uny * dimOffset
    d2x = x2 + unx * dimOffset; d2y = y2 + uny * dimOffset
    labelX = (d1x + d2x) / 2; labelY = (d1y + d2y) / 2
  }

  // Determine if the label is inside the dimension line (between d1 and d2).
  // ASCII visualizations (in world coordinates, with d1 on the left, d2 on the right):
  //   Inside:        |<---X--->|
  //     Arrows at boundaries pointing outward, label sits between them.
  //   Outside near d1:   X--->|------|<-
  //     Both arrows point inward, leader line from d1 to label.
  //   Outside near d2:   |----->|<------X
  //     Both arrows point inward, leader line from d2 to label.
  //
  // Note: For parallel lines, the arrows should remain aligned with the dimension line,
  // not skewed or offset. The dimension line (d1→d2) is parallel to the measured line (x1→x2),
  // so arrows should point along the dimension line direction only.
  const dimLen = Math.hypot(d2x - d1x, d2y - d1y)
  const udirX = dimLen > 0 ? (d2x - d1x) / dimLen : 1
  const udirY = dimLen > 0 ? (d2y - d1y) / dimLen : 0
  // Project label onto the d1→d2 axis.
  const tLabel = (labelX - d1x) * udirX + (labelY - d1y) * udirY
  const isInside = tLabel >= 0 && tLabel <= dimLen

  const label = dim.value % 1 === 0 ? String(dim.value) : dim.value.toFixed(2)

  const onPointerDown = useCallback((e: { stopPropagation: () => void }) => {
    if (!interaction) return
    e.stopPropagation()
    resetDragMoved()
    setOrbitEnabled(false)
    setDrag({
      type: 'dim_label',
      constraintId: cid,
      featureId: interaction.featureId,
      anchorWorld: [anchorX, anchorY],
      startWorld: [labelX, labelY],
      currentWorld: [labelX, labelY],
    })
  }, [interaction, cid, anchorX, anchorY, labelX, labelY, resetDragMoved, setDrag, setOrbitEnabled])

  return (
    <group key={cid}>
      <Line points={[[x1, y1, 0], [d1x, d1y, 0]]} color={color} lineWidth={1} />
      <Line points={[[x2, y2, 0], [d2x, d2y, 0]]} color={color} lineWidth={1} />
      <Line points={[[d1x, d1y, 0], [d2x, d2y, 0]]} color={color} lineWidth={1} />
      {isInside ? (
        // Inside: arrows at boundaries pointing outward.
        // |<---X--->|
        <>
          <Arrowhead tip={[d1x, d1y]} from={[d2x, d2y]} px={12} color={color} />
          <Arrowhead tip={[d2x, d2y]} from={[d1x, d1y]} px={12} color={color} />
        </>
      ) : tLabel < 0 ? (
        // Outside near d1: both arrows point inward (into the dimension line), leader from d1 to label.
        // X--->|------|<-
        <>
          <Arrowhead tip={[d1x, d1y]} from={[d1x - udirX, d1y - udirY]} px={12} color={color} />
          <Arrowhead tip={[d2x, d2y]} from={[d2x + udirX, d2y + udirY]} px={12} color={color} />
          <Line points={[[d1x, d1y, 0], [labelX, labelY, 0]]} color={color} lineWidth={1} />
        </>
      ) : (
        // Outside near d2: both arrows point inward (into the dimension line), leader from d2 to label.
        // Same arrow config as outside near d1, but different leader line.
        // |----->|<------X
        <>
          <Arrowhead tip={[d1x, d1y]} from={[d1x - udirX, d1y - udirY]} px={12} color={color} />
          <Arrowhead tip={[d2x, d2y]} from={[d2x + udirX, d2y + udirY]} px={12} color={color} />
          <Line points={[[d2x, d2y, 0], [labelX, labelY, 0]]} color={color} lineWidth={1} />
        </>
      )}
      <mesh ref={meshRef} position={[labelX, labelY, 0.001]} onPointerOver={onOver} onPointerOut={onOut} onClick={onClick} onPointerDown={onPointerDown}>
        <circleGeometry args={[1, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Html position={[labelX, labelY, 0.001]} center style={{ pointerEvents: 'none' }}>
        <div style={{ color, fontSize: 14, fontFamily: 'monospace', background: '#111', padding: '0 5px', borderRadius: 2, whiteSpace: 'nowrap' }}>
          {label}
        </div>
      </Html>
    </group>
  )
}

export function RadiusDimension({ cid, dim, interaction }: {
  cid: string
  dim: { kind: string; p1: [number, number]; p2: [number, number]; value: number; pos?: [number, number] }
  interaction?: DimInteraction
}) {
  const { color, onOver, onOut, onClick, resetDragMoved } = useDimInteraction(cid, dim.value, interaction)
  const activeDragPos = useActiveLabelDrag(cid)
  const meshRef = useRef<THREE.Mesh>(null)
  const setDrag = useSketchEditorStore(s => s.setDrag)
  const setOrbitEnabled = useSketchEditorStore(s => s.setOrbitEnabled)
  const { camera } = useThree()
  useFrame(() => {
    if (meshRef.current) meshRef.current.scale.setScalar(30 * p2w(camera))
  })

  // p1 = center, p2 = edge point; r is the circle/arc radius.
  const [cx, cy] = dim.p1
  const r = Math.hypot(dim.p2[0] - cx, dim.p2[1] - cy)

  const effectivePos: [number, number] | undefined = activeDragPos
    ? [activeDragPos[0] - cx, activeDragPos[1] - cy]
    : dim.pos

  let labelX: number, labelY: number, tipX: number, tipY: number

  if (effectivePos) {
    const [ox, oy] = effectivePos
    labelX = cx + ox; labelY = cy + oy
    // Arrow tip is on the circle boundary in the direction from center toward label.
    const d = Math.hypot(ox, oy)
    if (d > 0) {
      tipX = cx + (ox / d) * r
      tipY = cy + (oy / d) * r
    } else {
      tipX = dim.p2[0]; tipY = dim.p2[1]
    }
  } else {
    // Default: rotate slightly off-axis, label at midpoint.
    const angle = 10 * (Math.PI / 180)
    const dx = dim.p2[0] - cx, dy = dim.p2[1] - cy
    tipX = cx + dx * Math.cos(angle) - dy * Math.sin(angle)
    tipY = cy + dx * Math.sin(angle) + dy * Math.cos(angle)
    labelX = (cx + tipX) / 2; labelY = (cy + tipY) / 2
  }

  // Determine if the label is inside the circle (between center and edge) or outside.
  // ASCII visualizations (center at o, edge at |):
  //   Inside (circle):   o---X--->|
  //     Line from center through label to edge, arrow at edge pointing outward.
  //   Outside (circle):  o------|<---X
  //     Line from center through edge to label, arrow at edge pointing inward.
  //
  // For arc entities, if the label direction falls outside the arc's angular range,
  // the arc should be virtually extended with a thin dashed dimension line to show
  // that the dimension applies to the extended geometry. This would require knowing
  // the arc range (p1, p2 endpoints + center) to detect if label is outside arc span.
  const labelDist = Math.hypot(labelX - cx, labelY - cy)
  const isInside = labelDist <= r

  const label = `R${dim.value % 1 === 0 ? dim.value : dim.value.toFixed(2)}`

  const onPointerDown = useCallback((e: { stopPropagation: () => void }) => {
    if (!interaction) return
    e.stopPropagation()
    resetDragMoved()
    setOrbitEnabled(false)
    setDrag({
      type: 'dim_label',
      constraintId: cid,
      featureId: interaction.featureId,
      anchorWorld: [cx, cy],
      startWorld: [labelX, labelY],
      currentWorld: [labelX, labelY],
    })
  }, [interaction, cid, cx, cy, labelX, labelY, resetDragMoved, setDrag, setOrbitEnabled])

  return (
    <group key={cid}>
      {isInside ? (
        // Inside: line from center to edge, arrow at edge pointing outward.
        <>
          <Line points={[[cx, cy, 0], [tipX, tipY, 0]]} color={color} lineWidth={1} />
          <Arrowhead tip={[tipX, tipY]} from={[cx, cy]} px={12} color={color} />
        </>
      ) : (
        // Outside: line extends from center through edge all the way to label,
        // arrow at edge is inverted (points inward toward center).
        <>
          <Line points={[[cx, cy, 0], [labelX, labelY, 0]]} color={color} lineWidth={1} />
          <Arrowhead tip={[tipX, tipY]} from={[labelX, labelY]} px={12} color={color} />
        </>
      )}
      <mesh ref={meshRef} position={[labelX, labelY, 0.001]} onPointerOver={onOver} onPointerOut={onOut} onClick={onClick} onPointerDown={onPointerDown}>
        <circleGeometry args={[1, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Html position={[labelX, labelY, 0.001]} center style={{ pointerEvents: 'none' }}>
        <div style={{ color, fontSize: 14, fontFamily: 'monospace', background: '#111', padding: '0 5px', borderRadius: 2, whiteSpace: 'nowrap' }}>
          {label}
        </div>
      </Html>
    </group>
  )
}

export function DiameterDimension({ cid, dim, interaction }: {
  cid: string
  dim: { kind: string; p1: [number, number]; p2: [number, number]; value: number; pos?: [number, number] }
  interaction?: DimInteraction
}) {
  const { color, onOver, onOut, onClick, resetDragMoved } = useDimInteraction(cid, dim.value, interaction)
  const activeDragPos = useActiveLabelDrag(cid)
  const meshRef = useRef<THREE.Mesh>(null)
  const setDrag = useSketchEditorStore(s => s.setDrag)
  const setOrbitEnabled = useSketchEditorStore(s => s.setOrbitEnabled)
  const { camera } = useThree()
  useFrame(() => {
    if (meshRef.current) meshRef.current.scale.setScalar(30 * p2w(camera))
  })

  // p1 and p2 are the two endpoints of the diameter; center is their midpoint.
  const anchorX = (dim.p1[0] + dim.p2[0]) / 2, anchorY = (dim.p1[1] + dim.p2[1]) / 2
  const r = Math.hypot(dim.p2[0] - dim.p1[0], dim.p2[1] - dim.p1[1]) / 2

  const effectivePos: [number, number] | undefined = activeDragPos
    ? [activeDragPos[0] - anchorX, activeDragPos[1] - anchorY]
    : dim.pos

  let ep1x: number, ep1y: number, ep2x: number, ep2y: number, labelX: number, labelY: number

  if (effectivePos) {
    const [ox, oy] = effectivePos
    labelX = anchorX + ox; labelY = anchorY + oy
    // Rotate the diameter line to point along the drag direction.
    const angle = Math.atan2(oy, ox)
    ep1x = anchorX - r * Math.cos(angle); ep1y = anchorY - r * Math.sin(angle)
    ep2x = anchorX + r * Math.cos(angle); ep2y = anchorY + r * Math.sin(angle)
  } else {
    ep1x = dim.p1[0]; ep1y = dim.p1[1]
    ep2x = dim.p2[0]; ep2y = dim.p2[1]
    labelX = anchorX; labelY = anchorY
  }

  // Determine if label is inside or outside the circle.
  // ASCII visualizations (center at o, endpoints at |):
  //   Inside (within circle):   |<--X--o----->|
  //     Arrows at endpoints pointing outward (away from center), label within circle bounds.
  //   Outside (beyond circle):  ->|---o----|<--X
  //     Arrows at endpoints pointing inward (toward center), leader line from endpoint to label.
  const labelDist = Math.hypot(labelX - anchorX, labelY - anchorY)
  const isInside = labelDist <= r
  const diamLen = Math.hypot(ep2x - ep1x, ep2y - ep1y)
  const udirX = diamLen > 0 ? (ep2x - ep1x) / diamLen : 1
  const udirY = diamLen > 0 ? (ep2y - ep1y) / diamLen : 0

  const label = `Ø${dim.value % 1 === 0 ? dim.value : dim.value.toFixed(2)}`

  const onPointerDown = useCallback((e: { stopPropagation: () => void }) => {
    if (!interaction) return
    e.stopPropagation()
    resetDragMoved()
    setOrbitEnabled(false)
    setDrag({
      type: 'dim_label',
      constraintId: cid,
      featureId: interaction.featureId,
      anchorWorld: [anchorX, anchorY],
      startWorld: [labelX, labelY],
      currentWorld: [labelX, labelY],
    })
  }, [interaction, cid, anchorX, anchorY, labelX, labelY, resetDragMoved, setDrag, setOrbitEnabled])

  return (
    <group key={cid}>
      <Line points={[[ep1x, ep1y, 0], [ep2x, ep2y, 0]]} color={color} lineWidth={1} />
      {isInside ? (
        // Inside circle: arrows at endpoints pointing outward.
        // |<--X--o----->|
        <>
          <Arrowhead tip={[ep1x, ep1y]} from={[ep2x, ep2y]} px={12} color={color} />
          <Arrowhead tip={[ep2x, ep2y]} from={[ep1x, ep1y]} px={12} color={color} />
        </>
      ) : (
        // Outside circle: both arrows point inward (toward center).
        // X--->|---o----|<--
        <>
          <Arrowhead tip={[ep1x, ep1y]} from={[ep1x - udirX, ep1y - udirY]} px={12} color={color} />
          <Arrowhead tip={[ep2x, ep2y]} from={[ep2x + udirX, ep2y + udirY]} px={12} color={color} />
          <Line points={[[ep1x, ep1y, 0], [labelX, labelY, 0]]} color={color} lineWidth={1} />
        </>
      )}
      <mesh ref={meshRef} position={[labelX, labelY, 0.001]} onPointerOver={onOver} onPointerOut={onOut} onClick={onClick} onPointerDown={onPointerDown}>
        <circleGeometry args={[1, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Html position={[labelX, labelY, 0.001]} center style={{ pointerEvents: 'none' }}>
        <div style={{ color, fontSize: 14, fontFamily: 'monospace', background: '#111', padding: '0 5px', borderRadius: 2, whiteSpace: 'nowrap' }}>
          {label}
        </div>
      </Html>
    </group>
  )
}

export function AngleDimension({ cid, dim, interaction }: {
  cid: string
  dim: { kind: string; p1: [number, number]; p2: [number, number]; p3: [number, number]; p4: [number, number]; value: number; pos?: [number, number] }
  interaction?: DimInteraction
}) {
  const { color, onOver, onOut, onClick, resetDragMoved } = useDimInteraction(cid, dim.value, interaction, false)
  const activeDragPos = useActiveLabelDrag(cid)
  const meshRef = useRef<THREE.Mesh>(null)
  const setDrag = useSketchEditorStore(s => s.setDrag)
  const setOrbitEnabled = useSketchEditorStore(s => s.setOrbitEnabled)
  const { camera } = useThree()
  useFrame(() => {
    if (meshRef.current) meshRef.current.scale.setScalar(30 * p2w(camera))
  })

  // p1,p2 = line A endpoints; da = p2 - p1 (solver's forward direction of A).
  // p3,p4 = line B endpoints; db = p4 - p3 (solver's forward direction of B).
  // The arc spans from angle_da to angle_db, matching the constrained angle.
  const [ax1, ay1] = dim.p1, [ax2, ay2] = dim.p2  // line A
  const [bx1, by1] = dim.p3, [bx2, by2] = dim.p4  // line B

  const angle1 = Math.atan2(ay2 - ay1, ax2 - ax1)  // direction of da
  const angle2 = Math.atan2(by2 - by1, bx2 - bx1)  // direction of db

  // Find the shared vertex (the endpoint common to both lines).
  const EPS = 1e-6
  let vx: number, vy: number
  // Check all 4 endpoint combinations; fall back to line A's end.
  if (Math.hypot(ax2 - bx1, ay2 - by1) < EPS) { vx = ax2; vy = ay2 }       // ea.end = eb.start
  else if (Math.hypot(ax2 - bx2, ay2 - by2) < EPS) { vx = ax2; vy = ay2 }  // ea.end = eb.end
  else if (Math.hypot(ax1 - bx1, ay1 - by1) < EPS) { vx = ax1; vy = ay1 }  // ea.start = eb.start
  else if (Math.hypot(ax1 - bx2, ay1 - by2) < EPS) { vx = ax1; vy = ay1 }  // ea.start = eb.end
  else { vx = ax2; vy = ay2 }  // no shared vertex — best guess

  // Points on each line for extension lines (the other endpoint from the vertex).
  const extAx = Math.abs(ax2 - vx) + Math.abs(ay2 - vy) > EPS ? ax2 : ax1
  const extAy = Math.abs(ax2 - vx) + Math.abs(ay2 - vy) > EPS ? ay2 : ay1
  const extBx = Math.abs(bx2 - vx) + Math.abs(by2 - vy) > EPS ? bx2 : bx1
  const extBy = Math.abs(bx2 - vx) + Math.abs(by2 - vy) > EPS ? by2 : by1

  const effectivePos: [number, number] | undefined = activeDragPos
    ? [activeDragPos[0] - vx, activeDragPos[1] - vy]
    : dim.pos

  let arcR: number, labelX: number, labelY: number

  if (effectivePos) {
    arcR = Math.hypot(effectivePos[0], effectivePos[1])
    labelX = vx + effectivePos[0]; labelY = vy + effectivePos[1]
  } else {
    const rA = Math.hypot(extAx - vx, extAy - vy)
    const rB = Math.hypot(extBx - vx, extBy - vy)
    arcR = Math.min(rA, rB) * 0.4
    // Compute midAngle consistently with sampleArc (always shorter arc).
    const a1deg = angle1 * (180 / Math.PI)
    const a2deg = angle2 * (180 / Math.PI)
    let spanDeg = ((a2deg - a1deg) + 360) % 360
    if (spanDeg > 180) spanDeg -= 360
    const midAngle = angle1 + (spanDeg / 2) * (Math.PI / 180)
    labelX = vx + arcR * Math.cos(midAngle)
    labelY = vy + arcR * Math.sin(midAngle)
  }

  const arcPts = sampleArc(vx, vy, arcR, angle1 * (180 / Math.PI), angle2 * (180 / Math.PI))

  // Determine if label is inside or outside the angle arc.
  // ASCII visualizations (with arc segments instead of straight lines, vertex at |):
  //   Inside angle:    |<---arc-X-arc--->|
  //     Arrows at arc endpoints pointing outward from vertex.
  //   Outside angle:   X-arc----|  |----arc-<
  //     Arrows at arc endpoints pointing inward toward vertex, leader line to label.
  //
  // Detection: project label direction onto the angle arc. If it falls within the
  // angle span (between angle1 and angle2), it's inside; otherwise it's outside.
  const labelAngle = Math.atan2(labelY - vy, labelX - vx)

  // Normalize angles to [0, 360) for comparison
  let a1Norm = (angle1 * (180 / Math.PI) + 360) % 360
  let a2Norm = (angle2 * (180 / Math.PI) + 360) % 360
  let labelNorm = (labelAngle * (180 / Math.PI) + 360) % 360

  // Determine if label is within the arc span
  let isInsideAngle: boolean
  if (a1Norm <= a2Norm) {
    // Arc spans normally (e.g., 30° to 120°)
    isInsideAngle = labelNorm >= a1Norm && labelNorm <= a2Norm
  } else {
    // Arc wraps around 360° (e.g., 320° to 50°)
    isInsideAngle = labelNorm >= a1Norm || labelNorm <= a2Norm
  }

  const label = `${dim.value % 1 === 0 ? dim.value : dim.value.toFixed(1)}°`

  const onPointerDown = useCallback((e: { stopPropagation: () => void }) => {
    if (!interaction) return
    e.stopPropagation()
    resetDragMoved()
    setOrbitEnabled(false)
    setDrag({
      type: 'dim_label',
      constraintId: cid,
      featureId: interaction.featureId,
      anchorWorld: [vx, vy],
      startWorld: [labelX, labelY],
      currentWorld: [labelX, labelY],
    })
  }, [interaction, cid, vx, vy, labelX, labelY, resetDragMoved, setDrag, setOrbitEnabled])

  // Get arc endpoints for arrow placement
  const arcStartPt = arcPts.length > 0 ? arcPts[0] : [extAx, extAy, 0]
  const arcEndPt = arcPts.length > 0 ? arcPts[arcPts.length - 1] : [extBx, extBy, 0]

  return (
    <group key={cid}>
      <Line points={[[vx, vy, 0], [extAx, extAy, 0]]} color={color} lineWidth={1} />
      <Line points={[[vx, vy, 0], [extBx, extBy, 0]]} color={color} lineWidth={1} />
      <Line points={arcPts} color={color} lineWidth={1} />
      {isInsideAngle ? (
        // Inside angle: arrows at arc endpoints pointing outward from vertex
        // |<---arc-X-arc--->|
        <>
          <Arrowhead tip={[arcStartPt[0], arcStartPt[1]]} from={[vx, vy]} px={12} color={color} />
          <Arrowhead tip={[arcEndPt[0], arcEndPt[1]]} from={[vx, vy]} px={12} color={color} />
        </>
      ) : (
        // Outside angle: arrows at arc endpoints pointing inward toward vertex, leader line to label
        // X-arc----|  |----arc-<
        <>
          <Arrowhead tip={[arcStartPt[0], arcStartPt[1]]} from={[labelX, labelY]} px={12} color={color} />
          <Arrowhead tip={[arcEndPt[0], arcEndPt[1]]} from={[labelX, labelY]} px={12} color={color} />
          <Line points={[[arcStartPt[0], arcStartPt[1], 0], [labelX, labelY, 0]]} color={color} lineWidth={1} />
        </>
      )}
      <mesh ref={meshRef} position={[labelX, labelY, 0.001]} onPointerOver={onOver} onPointerOut={onOut} onClick={onClick} onPointerDown={onPointerDown}>
        <circleGeometry args={[1, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Html position={[labelX, labelY, 0.001]} center style={{ pointerEvents: 'none' }}>
        <div style={{ color, fontSize: 18, fontFamily: 'monospace', background: '#111', padding: '0 6px', borderRadius: 2, whiteSpace: 'nowrap' }}>
          {label}
        </div>
      </Html>
    </group>
  )
}

// ---------------------------------------------------------------------------
// Read-only constraint overlays (used by Sketch3D / Visualizer)
// ---------------------------------------------------------------------------

interface ConstraintOverlaysProps {
  constraints: Constraints
  sketch: Sketch
  extent: number
}

export function ConstraintOverlays({ constraints, sketch, extent }: ConstraintOverlaysProps) {
  const dimOffset = extent * 0.1

  const byEntity: Record<string, [string, Constraints[string]][]> = {}
  for (const [id, c] of Object.entries(constraints)) {
    const eid = (c.render as { entity?: string }).entity || 'default'
    if (!byEntity[eid]) byEntity[eid] = []
    byEntity[eid].push([id, c])
  }

  const symbolElements: React.ReactNode[] = []
  const dimElements: React.ReactNode[] = []

  for (const [eid, clist] of Object.entries(byEntity)) {
    const entity = sketch[eid] as Entity | undefined
    if (!entity) continue
    const bounds = getEntityBounds(entity)
    const symbolIcons: { url: string; key: string }[] = []

    for (const [cid, c] of clist) {
      const r = c.render as unknown as { kind: string; [key: string]: unknown }

      if (r.kind.startsWith('symbol_')) {
        const url = getIconUrl(r.kind)
        if (!url) continue
        symbolIcons.push({ url, key: cid })
      } else if (r.kind === 'dim_linear') {
        const dim = r as { kind: string; p1: [number, number]; p2: [number, number]; normal: [number, number]; value: number; pos?: [number, number] }
        dimElements.push(<LinearDimension key={cid} cid={cid} dim={dim} dimOffset={dimOffset} />)
      } else if (r.kind === 'dim_radius') {
        const dim = r as { kind: string; p1: [number, number]; p2: [number, number]; value: number; pos?: [number, number] }
        dimElements.push(<RadiusDimension key={cid} cid={cid} dim={dim} />)
      } else if (r.kind === 'dim_diameter') {
        const dim = r as { kind: string; p1: [number, number]; p2: [number, number]; value: number; pos?: [number, number] }
        dimElements.push(<DiameterDimension key={cid} cid={cid} dim={dim} />)
      } else if (r.kind === 'dim_angle') {
        const dim = r as { kind: string; p1: [number, number]; p2: [number, number]; p3: [number, number]; p4: [number, number]; value: number; pos?: [number, number] }
        if (!dim.p3 || !dim.p4) continue
        dimElements.push(<AngleDimension key={cid} cid={cid} dim={dim} />)
      }
    }

    if (symbolIcons.length > 0) {
      const colWidth = ICON_SIZE + 2
      const groupWidth = Math.min(ICON_COLS, symbolIcons.length) * colWidth
      symbolElements.push(
        <Html key={`icons-${eid}`} position={[bounds.maxX, bounds.maxY, 0.001]} style={{ pointerEvents: 'auto' }}>
          <div style={{ marginLeft: 20, marginTop: -8, display: 'flex', flexWrap: 'wrap', width: groupWidth, gap: 2 }}>
            {symbolIcons.map(({ url, key }) => (
              <ConstraintTile key={key} url={url} id={key} />
            ))}
          </div>
        </Html>
      )
    }
  }

  return <>{[...symbolElements, ...dimElements]}</>
}
