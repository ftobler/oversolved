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
      <Arrowhead tip={[d1x, d1y]} from={[d2x, d2y]} px={12} color={color} />
      <Arrowhead tip={[d2x, d2y]} from={[d1x, d1y]} px={12} color={color} />
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
      <Line points={[[cx, cy, 0], [tipX, tipY, 0]]} color={color} lineWidth={1} />
      <Arrowhead tip={[tipX, tipY]} from={[cx, cy]} px={12} color={color} />
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
      <Arrowhead tip={[ep1x, ep1y]} from={[ep2x, ep2y]} px={12} color={color} />
      <Arrowhead tip={[ep2x, ep2y]} from={[ep1x, ep1y]} px={12} color={color} />
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
  dim: { kind: string; p1: [number, number]; p2: [number, number]; p3?: [number, number]; value: number; pos?: [number, number] }
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

  if (!dim.p3) return null

  // p2 is the vertex; p1 and p3 are points on the two lines.
  const [vx, vy] = dim.p2, [x1, y1] = dim.p1, [x3, y3] = dim.p3
  const angle1 = Math.atan2(y1 - vy, x1 - vx)
  const angle2 = Math.atan2(y3 - vy, x3 - vx)

  const effectivePos: [number, number] | undefined = activeDragPos
    ? [activeDragPos[0] - vx, activeDragPos[1] - vy]
    : dim.pos

  let arcR: number, labelX: number, labelY: number

  if (effectivePos) {
    arcR = Math.hypot(effectivePos[0], effectivePos[1])
    labelX = vx + effectivePos[0]; labelY = vy + effectivePos[1]
  } else {
    const r1 = Math.hypot(x1 - vx, y1 - vy), r2 = Math.hypot(x3 - vx, y3 - vy)
    arcR = Math.min(r1, r2) * 0.4
    const midAngle = (angle1 + angle2) / 2
    labelX = vx + arcR * Math.cos(midAngle)
    labelY = vy + arcR * Math.sin(midAngle)
  }

  const arcPts = sampleArc(vx, vy, arcR, angle1 * (180 / Math.PI), angle2 * (180 / Math.PI))
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

  return (
    <group key={cid}>
      <Line points={[[vx, vy, 0], [x1, y1, 0]]} color={color} lineWidth={1} />
      <Line points={[[vx, vy, 0], [x3, y3, 0]]} color={color} lineWidth={1} />
      <Line points={arcPts} color={color} lineWidth={1} />
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
        const dim = r as { kind: string; p1: [number, number]; p2: [number, number]; p3?: [number, number]; value: number; pos?: [number, number] }
        if (!dim.p3) continue
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
