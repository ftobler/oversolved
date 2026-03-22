import { useRef, useState } from 'react'
import { Line, Html } from '@react-three/drei'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Sketch, Constraints, Entity, LineSegment, Circle, Arc, PointEntity } from '../types/cad'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const COLOR_CONSTRAINT = '#ffd54f'
const ICON_SIZE = 22
const ICON_COLS = 3

const iconModules = import.meta.glob('../assets/icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

const SYMBOL_TO_ICON: Record<string, string> = {
  symbol_h:          'constraint-horizontal',
  symbol_v:          'constraint-vertical',
  symbol_coincident: 'constraint-coincident',
  symbol_concentric: 'constraint-concentric',
  symbol_equal:      'constraint-equal',
  symbol_fixed:      'constraint-fixed',
  symbol_midpoint:   'constraint-midpoint',
  symbol_normal:     'constraint-normal',
  symbol_parallel:   'constraint-parallel',
  symbol_perp:       'constraint-square',
  symbol_tangent:    'constraint-tangent',
  symbol_colinear:   'constraint-colinear',
  symbol_angle:      'constraint-angle',
}

function getIconUrl(kind: string): string | undefined {
  const name = SYMBOL_TO_ICON[kind]
  if (!name) return undefined
  return iconModules[`../assets/icons/${name}.svg`]
}

// ---------------------------------------------------------------------------
// Shared primitives (also exported for use in Sketch3D)
// ---------------------------------------------------------------------------

/** World units per pixel for an orthographic camera. */
export function p2w(camera: THREE.Camera): number {
  return 'zoom' in camera ? 1 / (camera as THREE.OrthographicCamera).zoom : 1
}

/** Pre-built unit arrow shape: tip at origin, pointing +X, base at x=-1 */
export const ARROW_SHAPE = (() => {
  const s = new THREE.Shape()
  s.moveTo(0, 0)
  s.lineTo(-1, 0.4)
  s.lineTo(-1, -0.4)
  s.closePath()
  return s
})()

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

export function sampleArc(cx: number, cy: number, r: number, a0deg: number, a1deg: number): [number, number, number][] {
  let span = ((a1deg - a0deg) + 360) % 360
  const isFullCircle = span === 0
  if (isFullCircle) span = 360
  else if (span > 180) span = span - 360
  const steps = Math.max(2, Math.ceil((Math.abs(span) / 360) * 64))
  const pts: [number, number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const a = (a0deg + (span * i) / steps) * (Math.PI / 180)
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), 0])
  }
  return pts
}

export function getEntityBounds(entity: Entity): { minX: number; maxX: number; minY: number; maxY: number } {
  if ('start' in entity && 'end' in entity && 'radius' in entity) {
    const arc = entity as Arc
    const pts: [number, number][] = [arc.start, arc.end,
      [arc.center[0] - arc.radius, arc.center[1]], [arc.center[0] + arc.radius, arc.center[1]],
      [arc.center[0], arc.center[1] - arc.radius], [arc.center[0], arc.center[1] + arc.radius],
    ]
    return { minX: Math.min(...pts.map(p => p[0])), maxX: Math.max(...pts.map(p => p[0])), minY: Math.min(...pts.map(p => p[1])), maxY: Math.max(...pts.map(p => p[1])) }
  } else if ('start' in entity) {
    const l = entity as LineSegment
    return { minX: Math.min(l.start[0], l.end[0]), maxX: Math.max(l.start[0], l.end[0]), minY: Math.min(l.start[1], l.end[1]), maxY: Math.max(l.start[1], l.end[1]) }
  } else if ('center' in entity) {
    const c = entity as Circle
    return { minX: c.center[0] - c.radius, maxX: c.center[0] + c.radius, minY: c.center[1] - c.radius, maxY: c.center[1] + c.radius }
  } else {
    const p = entity as PointEntity
    return { minX: p.x, maxX: p.x, minY: p.y, maxY: p.y }
  }
}

// ---------------------------------------------------------------------------
// Constraint symbol tile
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
// Dimension components
// ---------------------------------------------------------------------------

function LinearDimension({ cid, dim, dimOffset }: { cid: string; dim: { kind: string; p1: [number, number]; p2: [number, number]; normal: [number, number]; value: number }; dimOffset: number }) {
  const [hovered, setHovered] = useState(false)
  const [x1, y1] = dim.p1,
    [x2, y2] = dim.p2
  const nx = dim.normal[0],
    ny = dim.normal[1]
  const nlen = Math.sqrt(nx * nx + ny * ny) || 1
  const unx = nx / nlen,
    uny = ny / nlen
  const d1x = x1 + unx * dimOffset,
    d1y = y1 + uny * dimOffset
  const d2x = x2 + unx * dimOffset,
    d2y = y2 + uny * dimOffset
  const mx = (d1x + d2x) / 2,
    my = (d1y + d2y) / 2
  const label = dim.value % 1 === 0 ? String(dim.value) : dim.value.toFixed(2)
  const color = hovered ? '#ffffff' : COLOR_CONSTRAINT
  const onOver = (ev: { stopPropagation: () => void }) => { ev.stopPropagation(); setHovered(true) }
  const onOut = () => setHovered(false)
  const dimLinePts: [number, number, number][] = [[d1x, d1y, 0], [d2x, d2y, 0]]
  const meshRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  useFrame(() => {
    if (meshRef.current) meshRef.current.scale.setScalar(30 * p2w(camera))
  })

  return (
    <group key={cid}>
      <DashedLine points={[[x1, y1, 0], [d1x, d1y, 0]]} color={color} lineWidth={1} />
      <DashedLine points={[[x2, y2, 0], [d2x, d2y, 0]]} color={color} lineWidth={1} />
      <Line points={dimLinePts} color={color} lineWidth={1} />
      <Arrowhead tip={[d1x, d1y]} from={[d2x, d2y]} px={12} color={color} />
      <Arrowhead tip={[d2x, d2y]} from={[d1x, d1y]} px={12} color={color} />
      <mesh ref={meshRef} position={[mx, my, 0.001]} onPointerOver={onOver} onPointerOut={onOut}>
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

function RadiusDimension({ cid, dim }: { cid: string; dim: { kind: string; p1: [number, number]; p2: [number, number]; value: number } }) {
  const [hovered, setHovered] = useState(false)
  const [x1, y1] = dim.p1,
    [x2, y2] = dim.p2
  const angle = 10 * (Math.PI / 180)
  const dx = x2 - x1,
    dy = y2 - y1
  const x2r = x1 + dx * Math.cos(angle) - dy * Math.sin(angle)
  const y2r = y1 + dx * Math.sin(angle) + dy * Math.cos(angle)
  const mx = (x1 + x2r) / 2,
    my = (y1 + y2r) / 2
  const label = `R${dim.value % 1 === 0 ? dim.value : dim.value.toFixed(2)}`
  const color = hovered ? '#ffffff' : COLOR_CONSTRAINT
  const onOver = (ev: { stopPropagation: () => void }) => { ev.stopPropagation(); setHovered(true) }
  const onOut = () => setHovered(false)
  const meshRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  useFrame(() => {
    if (meshRef.current) meshRef.current.scale.setScalar(30 * p2w(camera))
  })

  return (
    <group key={cid}>
      <Line points={[[x1, y1, 0], [x2r, y2r, 0]]} color={color} lineWidth={1} />
      <Arrowhead tip={[x2r, y2r]} from={[x1, y1]} px={12} color={color} />
      <mesh ref={meshRef} position={[mx, my, 0.001]} onPointerOver={onOver} onPointerOut={onOut}>
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

function AngleDimension({ cid, dim }: { cid: string; dim: { kind: string; p1: [number, number]; p2: [number, number]; p3?: [number, number]; value: number } }) {
  const [hovered, setHovered] = useState(false)
  if (!dim.p3) return null
  const [vx, vy] = dim.p2,
    [x1, y1] = dim.p1,
    [x3, y3] = dim.p3
  const angle1 = Math.atan2(y1 - vy, x1 - vx)
  const angle2 = Math.atan2(y3 - vy, x3 - vx)
  const r1 = Math.hypot(x1 - vx, y1 - vy),
    r2 = Math.hypot(x3 - vx, y3 - vy)
  const arcR = Math.min(r1, r2) * 0.4
  const arcPts = sampleArc(vx, vy, arcR, angle1 * (180 / Math.PI), angle2 * (180 / Math.PI))
  const midAngle = (angle1 + angle2) / 2
  const labelX = vx + arcR * Math.cos(midAngle),
    labelY = vy + arcR * Math.sin(midAngle)
  const label = `${dim.value % 1 === 0 ? dim.value : dim.value.toFixed(1)}°`
  const color = hovered ? '#ffffff' : COLOR_CONSTRAINT
  const onOver = (ev: { stopPropagation: () => void }) => { ev.stopPropagation(); setHovered(true) }
  const onOut = () => setHovered(false)
  const meshRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  useFrame(() => {
    if (meshRef.current) meshRef.current.scale.setScalar(30 * p2w(camera))
  })

  return (
    <group key={cid}>
      <Line points={[[vx, vy, 0], [x1, y1, 0]]} color={color} lineWidth={1} />
      <Line points={[[vx, vy, 0], [x3, y3, 0]]} color={color} lineWidth={1} />
      <Line points={arcPts} color={color} lineWidth={1} />
      <mesh ref={meshRef} position={[labelX, labelY, 0.001]} onPointerOver={onOver} onPointerOut={onOut}>
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
// Main export: ConstraintOverlays
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
      const r = (c.render as any) as { kind: string; [key: string]: unknown }

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
