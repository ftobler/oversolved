import { useRef, useState, useCallback } from 'react'
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
 *  When provided, hover highlights entities and click opens an edit prompt. */
export interface DimInteraction {
  featureId: string
  entityId: string
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
  const [hovered, setHovered] = useState(false)
  const onOver = useCallback((ev: { stopPropagation: () => void }) => {
    ev.stopPropagation()
    setHovered(true)
    if (interaction) setHoveredConstraintEntities(new Set([interaction.entityId]))
  }, [interaction, setHoveredConstraintEntities])
  const onOut = useCallback(() => {
    setHovered(false)
    if (interaction) setHoveredConstraintEntities(new Set())
  }, [interaction, setHoveredConstraintEntities])
  const onClick = useCallback((ev: { stopPropagation: () => void }) => {
    if (!interaction) return
    ev.stopPropagation()
    const input = window.prompt(`Enter ${interaction.promptLabel} value (current: ${value})`)
    if (input === null) return
    const val = parseFloat(input)
    if (isNaN(val) || (validatePositive && val <= 0)) return
    useSketchEditorStore.getState().onMutation?.({ type: 'set_constraint_value', featureId: interaction.featureId, constraintId: cid, value: val })
  }, [interaction, cid, value, validatePositive])
  const color = hovered ? '#ffffff' : COLOR_CONSTRAINT
  return { hovered, color, onOver, onOut, onClick }
}

// ---------------------------------------------------------------------------
// Dimension components (exported — used by both Sketch3D and Geometry3D)
// ---------------------------------------------------------------------------

export function LinearDimension({ cid, dim, dimOffset, interaction }: {
  cid: string
  dim: { kind: string; p1: [number, number]; p2: [number, number]; normal: [number, number]; value: number }
  dimOffset: number
  interaction?: DimInteraction
}) {
  const { color, onOver, onOut, onClick } = useDimInteraction(cid, dim.value, interaction)
  const meshRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  useFrame(() => {
    if (meshRef.current) meshRef.current.scale.setScalar(30 * p2w(camera))
  })
  const [x1, y1] = dim.p1, [x2, y2] = dim.p2
  const nx = dim.normal[0], ny = dim.normal[1]
  const nlen = Math.sqrt(nx * nx + ny * ny) || 1
  const unx = nx / nlen, uny = ny / nlen
  const d1x = x1 + unx * dimOffset, d1y = y1 + uny * dimOffset
  const d2x = x2 + unx * dimOffset, d2y = y2 + uny * dimOffset
  const mx = (d1x + d2x) / 2, my = (d1y + d2y) / 2
  const label = dim.value % 1 === 0 ? String(dim.value) : dim.value.toFixed(2)
  const dimLinePts: [number, number, number][] = [[d1x, d1y, 0], [d2x, d2y, 0]]

  return (
    <group key={cid}>
      <Line points={[[x1, y1, 0], [d1x, d1y, 0]]} color={color} lineWidth={1} />
      <Line points={[[x2, y2, 0], [d2x, d2y, 0]]} color={color} lineWidth={1} />
      <Line points={dimLinePts} color={color} lineWidth={1} />
      <Arrowhead tip={[d1x, d1y]} from={[d2x, d2y]} px={12} color={color} />
      <Arrowhead tip={[d2x, d2y]} from={[d1x, d1y]} px={12} color={color} />
      <mesh ref={meshRef} position={[mx, my, 0.001]} onPointerOver={onOver} onPointerOut={onOut} onClick={onClick}>
        <circleGeometry args={[1, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Html position={[mx, my, 0.001]} center style={{ pointerEvents: 'none' }}>
        <div style={{ color, fontSize: 14, fontFamily: 'monospace', background: '#111', padding: '0 5px', borderRadius: 2, whiteSpace: 'nowrap' }}>
          {label}
        </div>
      </Html>
    </group>
  )
}

export function RadiusDimension({ cid, dim, interaction }: {
  cid: string
  dim: { kind: string; p1: [number, number]; p2: [number, number]; value: number }
  interaction?: DimInteraction
}) {
  const { color, onOver, onOut, onClick } = useDimInteraction(cid, dim.value, interaction)
  const meshRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  useFrame(() => {
    if (meshRef.current) meshRef.current.scale.setScalar(30 * p2w(camera))
  })
  const [x1, y1] = dim.p1, [x2, y2] = dim.p2
  const angle = 10 * (Math.PI / 180)
  const dx = x2 - x1, dy = y2 - y1
  const x2r = x1 + dx * Math.cos(angle) - dy * Math.sin(angle)
  const y2r = y1 + dx * Math.sin(angle) + dy * Math.cos(angle)
  const mx = (x1 + x2r) / 2, my = (y1 + y2r) / 2
  const label = `R${dim.value % 1 === 0 ? dim.value : dim.value.toFixed(2)}`

  return (
    <group key={cid}>
      <Line points={[[x1, y1, 0], [x2r, y2r, 0]]} color={color} lineWidth={1} />
      <Arrowhead tip={[x2r, y2r]} from={[x1, y1]} px={12} color={color} />
      <mesh ref={meshRef} position={[mx, my, 0.001]} onPointerOver={onOver} onPointerOut={onOut} onClick={onClick}>
        <circleGeometry args={[1, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Html position={[mx, my, 0.001]} center style={{ pointerEvents: 'none' }}>
        <div style={{ color, fontSize: 14, fontFamily: 'monospace', background: '#111', padding: '0 5px', borderRadius: 2, whiteSpace: 'nowrap' }}>
          {label}
        </div>
      </Html>
    </group>
  )
}

export function DiameterDimension({ cid, dim, interaction }: {
  cid: string
  dim: { kind: string; p1: [number, number]; p2: [number, number]; value: number }
  interaction?: DimInteraction
}) {
  const { color, onOver, onOut, onClick } = useDimInteraction(cid, dim.value, interaction)
  const meshRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  useFrame(() => {
    if (meshRef.current) meshRef.current.scale.setScalar(30 * p2w(camera))
  })
  const [x1, y1] = dim.p1, [x2, y2] = dim.p2
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2
  const label = `Ø${dim.value % 1 === 0 ? dim.value : dim.value.toFixed(2)}`

  return (
    <group key={cid}>
      <Line points={[[x1, y1, 0], [x2, y2, 0]]} color={color} lineWidth={1} />
      <Arrowhead tip={[x1, y1]} from={[x2, y2]} px={12} color={color} />
      <Arrowhead tip={[x2, y2]} from={[x1, y1]} px={12} color={color} />
      <mesh ref={meshRef} position={[mx, my, 0.001]} onPointerOver={onOver} onPointerOut={onOut} onClick={onClick}>
        <circleGeometry args={[1, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Html position={[mx, my, 0.001]} center style={{ pointerEvents: 'none' }}>
        <div style={{ color, fontSize: 14, fontFamily: 'monospace', background: '#111', padding: '0 5px', borderRadius: 2, whiteSpace: 'nowrap' }}>
          {label}
        </div>
      </Html>
    </group>
  )
}

export function AngleDimension({ cid, dim, interaction }: {
  cid: string
  dim: { kind: string; p1: [number, number]; p2: [number, number]; p3?: [number, number]; value: number }
  interaction?: DimInteraction
}) {
  const { color, onOver, onOut, onClick } = useDimInteraction(cid, dim.value, interaction, false)
  const meshRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  useFrame(() => {
    if (meshRef.current) meshRef.current.scale.setScalar(30 * p2w(camera))
  })

  if (!dim.p3) return null
  const [vx, vy] = dim.p2, [x1, y1] = dim.p1, [x3, y3] = dim.p3
  const angle1 = Math.atan2(y1 - vy, x1 - vx)
  const angle2 = Math.atan2(y3 - vy, x3 - vx)
  const r1 = Math.hypot(x1 - vx, y1 - vy), r2 = Math.hypot(x3 - vx, y3 - vy)
  const arcR = Math.min(r1, r2) * 0.4
  const arcPts = sampleArc(vx, vy, arcR, angle1 * (180 / Math.PI), angle2 * (180 / Math.PI))
  const midAngle = (angle1 + angle2) / 2
  const labelX = vx + arcR * Math.cos(midAngle), labelY = vy + arcR * Math.sin(midAngle)
  const label = `${dim.value % 1 === 0 ? dim.value : dim.value.toFixed(1)}°`

  return (
    <group key={cid}>
      <Line points={[[vx, vy, 0], [x1, y1, 0]]} color={color} lineWidth={1} />
      <Line points={[[vx, vy, 0], [x3, y3, 0]]} color={color} lineWidth={1} />
      <Line points={arcPts} color={color} lineWidth={1} />
      <mesh ref={meshRef} position={[labelX, labelY, 0.001]} onPointerOver={onOver} onPointerOut={onOut} onClick={onClick}>
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
        const dim = r as { kind: string; p1: [number, number]; p2: [number, number]; normal: [number, number]; value: number }
        dimElements.push(<LinearDimension key={cid} cid={cid} dim={dim} dimOffset={dimOffset} />)
      } else if (r.kind === 'dim_radius') {
        const dim = r as { kind: string; p1: [number, number]; p2: [number, number]; value: number }
        dimElements.push(<RadiusDimension key={cid} cid={cid} dim={dim} />)
      } else if (r.kind === 'dim_diameter') {
        const dim = r as { kind: string; p1: [number, number]; p2: [number, number]; value: number }
        dimElements.push(<DiameterDimension key={cid} cid={cid} dim={dim} />)
      } else if (r.kind === 'dim_angle') {
        const dim = r as { kind: string; p1: [number, number]; p2: [number, number]; p3?: [number, number]; value: number }
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
