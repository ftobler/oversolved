import { useRef, useMemo, useState } from 'react'
import { Line, Html } from '@react-three/drei'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Sketch, Constraints, Topology } from './SketchSvg'

interface LineSegment { start: [number, number]; end: [number, number]; construction?: boolean }
interface Circle { center: [number, number]; radius: number; construction?: boolean }
interface Arc { center: [number, number]; radius: number; angle_start: number; angle_end: number; start: [number, number]; end: [number, number]; construction?: boolean }
interface PointEntity { x: number; y: number; construction?: boolean }
type Entity = LineSegment | Circle | Arc | PointEntity

const COLOR_INITIAL = '#66bb6a'
const COLOR_SOLVED = '#4fc3f7'
const COLOR_CONSTRAINT = '#ffd54f'
const COLOR_HOVER = '#ffffff'
const ARC_SEGMENTS = 64
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

// Pre-built unit arrow shape: tip at origin, pointing +X, base at x=-1
const ARROW_SHAPE = (() => {
  const s = new THREE.Shape()
  s.moveTo(0, 0)
  s.lineTo(-1, 0.4)
  s.lineTo(-1, -0.4)
  s.closePath()
  return s
})()

// ---------------------------------------------------------------------------
// Pixel-size helpers
// World units per pixel for an orthographic camera = 1 / camera.zoom
// (r3f default ortho: 1 world unit = 1px at zoom=1)
// ---------------------------------------------------------------------------

function p2w(camera: THREE.Camera): number {
  return 'zoom' in camera ? 1 / (camera as THREE.OrthographicCamera).zoom : 1
}

/** 10-gon dot with constant pixel radius regardless of zoom. */
function Dot({ x, y, px, color }: { x: number; y: number; px: number; color: string }) {
  const meshRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  useFrame(() => {
    if (meshRef.current) meshRef.current.scale.setScalar(px * p2w(camera))
  })
  return (
    <mesh ref={meshRef} position={[x, y, 0]}>
      <circleGeometry args={[1, 10]} />
      <meshBasicMaterial color={color} side={THREE.DoubleSide} />
    </mesh>
  )
}

/** Filled triangle arrowhead with constant pixel size regardless of zoom. */
function Arrowhead({ tip, from, px, color }: { tip: [number, number]; from: [number, number]; px: number; color: string }) {
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
function DashedLine({ points, color, lineWidth, dashPx = 7.5, gapPx = 4.5, onPointerOver, onPointerOut }: {
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

const HIT_PIXELS = 14

/** Invisible circle-mesh dots spaced densely along a polyline. Uses the same mechanism
 *  as the working endpoint Dot components — circleGeometry is reliably hittable. */
function HitPolyline({ pts, onPointerOver, onPointerOut }: {
  pts: [number, number, number][]
  onPointerOver: (e: { stopPropagation: () => void }) => void
  onPointerOut: () => void
}) {
  const dotRefs = useRef<(THREE.Mesh | null)[]>([])
  const { camera } = useThree()

  // Sample one dot every ~HIT_PIXELS world-units along each segment
  const dotPts = useMemo(() => {
    const result: [number, number, number][] = []
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1]
      const len = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
      const n = Math.max(1, Math.ceil(len / (HIT_PIXELS / 200))) // 200 = typical zoom
      for (let j = 0; j <= n; j++) {
        const t = j / n
        result.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, 0])
      }
    }
    return result
  }, [pts])

  useFrame(() => {
    const s = HIT_PIXELS * p2w(camera)
    dotRefs.current.forEach(ref => { if (ref) ref.scale.setScalar(s) })
  })

  return (
    <>
      {dotPts.map((p, i) => (
        <mesh key={i} ref={el => { dotRefs.current[i] = el }}
          position={p} onPointerOver={onPointerOver} onPointerOut={onPointerOut}
        >
          <circleGeometry args={[1, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function sampleArc(cx: number, cy: number, r: number, a0deg: number, a1deg: number): [number, number, number][] {
  let span = ((a1deg - a0deg) + 360) % 360
  const isFullCircle = span === 0
  if (isFullCircle) span = 360
  // Take shorter arc if > 180° (only for partial arcs, not full circles)
  else if (span > 180) span = span - 360
  const steps = Math.max(2, Math.ceil((Math.abs(span) / 360) * ARC_SEGMENTS))
  const pts: [number, number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const a = (a0deg + (span * i) / steps) * (Math.PI / 180)
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), 0])
  }
  return pts
}

function getEntityBounds(entity: Entity): { minX: number; maxX: number; minY: number; maxY: number } {
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

function sketchExtent(sketch: Sketch): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const entity of Object.values(sketch)) {
    const b = getEntityBounds(entity as Entity)
    minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX)
    minY = Math.min(minY, b.minY); maxY = Math.max(maxY, b.maxY)
  }
  return isFinite(minX) ? Math.max(maxX - minX, maxY - minY, 0.01) : 1
}

// ---------------------------------------------------------------------------
// Entity rendering
// ---------------------------------------------------------------------------

interface EntityItemProps {
  entity: Entity
  baseColor: string
  lineWidth?: number
}

function EntityItem({ entity, baseColor, lineWidth = 1 }: EntityItemProps) {
  const [hovered, setHovered] = useState(false)
  const color = hovered ? COLOR_HOVER : baseColor
  const lw = hovered ? lineWidth + 1 : lineWidth
  const e = entity
  const construction = 'construction' in e && e.construction
  const onOver = (ev: { stopPropagation: () => void }) => { ev.stopPropagation(); setHovered(true) }
  const onOut = () => setHovered(false)

  if ('start' in e && 'end' in e && 'radius' in e) {
    const arc = e as Arc
    const pts = sampleArc(arc.center[0], arc.center[1], arc.radius, arc.angle_start, arc.angle_end)
    return (
      <group onPointerOver={onOver} onPointerOut={onOut}>
        <HitPolyline pts={pts} onPointerOver={onOver} onPointerOut={onOut} />
        {construction
          ? <DashedLine points={pts} color={color} lineWidth={lw} />
          : <Line points={pts} color={color} lineWidth={lw} />}
        <Dot x={arc.start[0]} y={arc.start[1]} px={4} color={color} />
        <Dot x={arc.end[0]} y={arc.end[1]} px={4} color={color} />
        <Dot x={arc.center[0]} y={arc.center[1]} px={2.5} color={color} />
      </group>
    )
  } else if ('start' in e) {
    const line = e as LineSegment
    const pts: [number, number, number][] = [[line.start[0], line.start[1], 0], [line.end[0], line.end[1], 0]]
    return (
      <group onPointerOver={onOver} onPointerOut={onOut}>
        <HitPolyline pts={pts} onPointerOver={onOver} onPointerOut={onOut} />
        {construction
          ? <DashedLine points={pts} color={color} lineWidth={lw} />
          : <Line points={pts} color={color} lineWidth={lw} />}
        <Dot x={line.start[0]} y={line.start[1]} px={4} color={color} />
        <Dot x={line.end[0]} y={line.end[1]} px={4} color={color} />
      </group>
    )
  } else if ('x' in e) {
    const pt = e as PointEntity
    return (
      <group onPointerOver={onOver} onPointerOut={onOut}>
        <Dot x={pt.x} y={pt.y} px={5} color={color} />
      </group>
    )
  } else {
    const circ = e as Circle
    const pts = sampleArc(circ.center[0], circ.center[1], circ.radius, 0, 0)
    return (
      <group onPointerOver={onOver} onPointerOut={onOut}>
        <HitPolyline pts={pts} onPointerOver={onOver} onPointerOut={onOut} />
        {construction
          ? <DashedLine points={pts} color={color} lineWidth={lw} />
          : <Line points={pts} color={color} lineWidth={lw} />}
        <Dot x={circ.center[0]} y={circ.center[1]} px={2.5} color={color} />
      </group>
    )
  }
}

interface EntityLinesProps {
  sketch: Sketch
  color: string
  lineWidth?: number
}

function EntityLines({ sketch, color, lineWidth = 1 }: EntityLinesProps) {
  return (
    <>
      {Object.entries(sketch).map(([id, entity]) => (
        <EntityItem key={id} entity={entity as Entity} baseColor={color} lineWidth={lineWidth} />
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// Constraint rendering
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
        transition: 'background-color 0.15s',
      }}
    >
      <img
        src={url}
        width={ICON_SIZE - 4}
        height={ICON_SIZE - 4}
        style={{ filter: hovered ? 'invert(0)' : 'invert(1) sepia(1) saturate(5) hue-rotate(5deg)', opacity: hovered ? 1 : 0.9, transition: 'filter 0.15s, opacity 0.15s' }}
      />
    </div>
  )
}

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
  const color = hovered ? COLOR_HOVER : COLOR_CONSTRAINT
  const onOver = (ev: { stopPropagation: () => void }) => { ev.stopPropagation(); setHovered(true) }
  const onOut = () => setHovered(false)
  const dimLinePts: [number, number, number][] = [[d1x, d1y, 0], [d2x, d2y, 0]]

  return (
    <group key={cid}>
      <HitPolyline pts={dimLinePts} onPointerOver={onOver} onPointerOut={onOut} />
      <DashedLine points={[[x1, y1, 0], [d1x, d1y, 0]]} color={color} lineWidth={1} />
      <DashedLine points={[[x2, y2, 0], [d2x, d2y, 0]]} color={color} lineWidth={1} />
      <Line points={dimLinePts} color={color} lineWidth={1} />
      <Arrowhead tip={[d1x, d1y]} from={[d2x, d2y]} px={12} color={color} />
      <Arrowhead tip={[d2x, d2y]} from={[d1x, d1y]} px={12} color={color} />
      <Html position={[mx, my, 0.001]} center style={{ pointerEvents: 'none' }}>
        <div style={{ color, fontSize: 14, fontFamily: 'monospace', background: '#111', padding: '0 5px', borderRadius: 2, whiteSpace: 'nowrap', transition: 'color 0.15s' }}>
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
  const label = `${dim.value % 1 === 0 ? dim.value : dim.value.toFixed(1)}°`
  const color = hovered ? COLOR_HOVER : COLOR_CONSTRAINT
  const onOver = (ev: { stopPropagation: () => void }) => { ev.stopPropagation(); setHovered(true) }
  const onOut = () => setHovered(false)

  return (
    <group key={cid}>
      <HitPolyline pts={arcPts} onPointerOver={onOver} onPointerOut={onOut} />
      <Line points={[[vx, vy, 0], [x1, y1, 0]]} color={color} lineWidth={1} />
      <Line points={[[vx, vy, 0], [x3, y3, 0]]} color={color} lineWidth={1} />
      <Line points={arcPts} color={color} lineWidth={1} />
      <Html position={[vx + arcR * 1.5 * Math.cos(midAngle), vy + arcR * 1.5 * Math.sin(midAngle), 0.001]} center style={{ pointerEvents: 'none' }}>
        <div style={{ color, fontSize: 18, fontFamily: 'monospace', background: '#111', padding: '0 6px', borderRadius: 2, whiteSpace: 'nowrap', transition: 'color 0.15s' }}>
          {label}
        </div>
      </Html>
    </group>
  )
}

interface ConstraintOverlaysProps {
  constraints: Constraints
  sketch: Sketch
  extent: number
}

function ConstraintOverlays({ constraints, sketch, extent }: ConstraintOverlaysProps) {
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
      const r = c.render as { kind: string; [key: string]: unknown }

      if (r.kind.startsWith('symbol_')) {
        const url = getIconUrl(r.kind)
        if (!url) continue
        symbolIcons.push({ url, key: cid })

      } else if (r.kind === 'dim_linear') {
        const dim = r as { kind: string; p1: [number, number]; p2: [number, number]; normal: [number, number]; value: number }
        dimElements.push(<LinearDimension key={cid} cid={cid} dim={dim} dimOffset={dimOffset} />)

      } else if (r.kind === 'dim_radius') {
        const dim = r as { kind: string; p1: [number, number]; p2: [number, number]; value: number }
        const [x1, y1] = dim.p1, [x2, y2] = dim.p2
        const angle = 10 * (Math.PI / 180)
        const dx = x2 - x1, dy = y2 - y1
        const x2r = x1 + dx * Math.cos(angle) - dy * Math.sin(angle)
        const y2r = y1 + dx * Math.sin(angle) + dy * Math.cos(angle)
        const mx = (x1 + x2r) / 2, my = (y1 + y2r) / 2
        const label = `R${dim.value % 1 === 0 ? dim.value : dim.value.toFixed(2)}`

        dimElements.push(
          <group key={cid}>
            <Line points={[[x1, y1, 0], [x2r, y2r, 0]]} color={COLOR_CONSTRAINT} lineWidth={1} />
            <Arrowhead tip={[x2r, y2r]} from={[x1, y1]} px={12} color={COLOR_CONSTRAINT} />
            <Html position={[mx, my, 0.001]} center style={{ pointerEvents: 'none' }}>
              <div style={{ color: COLOR_CONSTRAINT, fontSize: 14, fontFamily: 'monospace', background: '#111', padding: '0 5px', borderRadius: 2, whiteSpace: 'nowrap' }}>
                {label}
              </div>
            </Html>
          </group>
        )

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
          <div style={{ marginLeft: 8, marginTop: -8, display: 'flex', flexWrap: 'wrap', width: groupWidth, gap: 2 }}>
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

// ---------------------------------------------------------------------------
// Topology surface rendering
// ---------------------------------------------------------------------------

interface TopologySurfacesProps {
  topology: Topology
}

type SurfaceShape = { shape: THREE.Shape; pts: [number, number][] }

function buildSurfaceShapes(topology: Topology): SurfaceShape[] {
  type ArcEdge = { kind: 'arc'; start: [number,number]; end: [number,number]; center: [number,number]; radius: number; angle_start_deg: number; angle_end_deg: number; ccw: boolean }
  type LineEdge = { kind: 'line'; start: [number,number]; end: [number,number] }

  return topology.surfaces.flatMap(surface => {
    const pts: [number, number][] = []
    surface.boundary.forEach((edge, ei) => {
      const e = edge as ArcEdge | LineEdge
      if (ei === 0) pts.push(e.start)
      if (e.kind === 'line') {
        pts.push(e.end)
      } else {
        const { center, radius, angle_start_deg, angle_end_deg, ccw } = e as ArcEdge
        const span = ccw
          ? ((angle_end_deg - angle_start_deg) + 360) % 360
          : -(((angle_start_deg - angle_end_deg) + 360) % 360)
        const steps = Math.max(2, Math.ceil((Math.abs(span) / 360) * ARC_SEGMENTS))
        for (let i = 1; i <= steps; i++) {
          const a = (angle_start_deg + (span * i) / steps) * (Math.PI / 180)
          pts.push([center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)])
        }
      }
    })
    if (pts.length < 3) return []
    const shape = new THREE.Shape()
    shape.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1])
    shape.closePath()
    return [{ shape, pts }]
  })
}

function SurfaceMesh({ shape }: { shape: THREE.Shape }) {
  const [hovered, setHovered] = useState(false)
  return (
    <mesh
      position={[0, 0, -0.001]}
      onPointerOver={e => { e.stopPropagation(); setHovered(true) }}
      onPointerOut={() => setHovered(false)}
    >
      <shapeGeometry args={[shape]} />
      <meshBasicMaterial color="white" transparent opacity={hovered ? 0.25 : 0.10} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  )
}

function TopologySurfaces({ topology }: TopologySurfacesProps) {
  const surfaces = useMemo(() => buildSurfaceShapes(topology), [topology])
  return (
    <>
      {surfaces.map((s, si) => <SurfaceMesh key={si} shape={s.shape} />)}
    </>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface Sketch3DProps {
  initial: Sketch
  solved: Sketch
  constraints?: Constraints
  topology?: Topology
}

export default function Sketch3D({ initial, solved, constraints, topology }: Sketch3DProps) {
  const extent = useMemo(() => sketchExtent(solved), [solved])

  return (
    <group>
      {topology && <TopologySurfaces topology={topology} />}
      <EntityLines sketch={initial} color={COLOR_INITIAL} lineWidth={1} />
      <EntityLines sketch={solved} color={COLOR_SOLVED} lineWidth={2} />
      {constraints && <ConstraintOverlays constraints={constraints} sketch={solved} extent={extent} />}
    </group>
  )
}
