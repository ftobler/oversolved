import { useRef, useMemo, useState } from 'react'
import { Line, Html } from '@react-three/drei'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Sketch, Constraints, Topology, Point, TopologySurface, TopologyEdge, TopologyArcEdge, Entity, LineSegment, Circle, Arc, PointEntity } from '../types/cad'

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

/** 10-gon dot with constant pixel radius regardless of zoom.
 *  If billboard=true the dot always faces the camera. */
function Dot({ x, y, px, color, billboard = false }: { x: number; y: number; px: number; color: string; billboard?: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  useFrame(() => {
    if (!meshRef.current) return
    meshRef.current.scale.setScalar(px * p2w(camera))
    if (billboard) meshRef.current.quaternion.copy(camera.quaternion)
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

const HIT_PIXELS = 8
const POINT_HIT_PIXELS = 20
const POINT_HIT_PIXELS_Z_OFFSET = 10

// Set to true to visualise hit geometry (orange cylinders for edges, blue spheres for vertices)
const DEBUG_HIT = false

/** One invisible cylinder per segment. Radius scales to HIT_PIXELS each frame so
 *  coverage is gapless at any zoom. Placed at z=-0.001 so vertex spheres (z=0,
 *  extending to z=+R) always win the raycast at endpoint positions. */
function HitPolyline({ pts, onPointerOver, onPointerOut }: {
  pts: [number, number, number][]
  onPointerOver: (e: { stopPropagation: () => void }) => void
  onPointerOut: () => void
}) {
  const segRefs = useRef<(THREE.Mesh | null)[]>([])
  const { camera } = useThree()

  // cylinder default axis is Y; rotate so Y aligns with segment direction
  const segs = useMemo(() => pts.slice(0, -1).map((p1, i) => {
    const p2 = pts[i + 1]
    const cx = (p1[0] + p2[0]) / 2, cy = (p1[1] + p2[1]) / 2
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1])
    const angle = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) - Math.PI / 2
    return { cx, cy, len, angle }
  }), [pts])

  useFrame(() => {
    const r = HIT_PIXELS * p2w(camera)
    segRefs.current.forEach((ref, i) => { if (ref) ref.scale.set(r, segs[i].len, r) })
  })

  return (
    <>
      {segs.map((s, i) => s.len > 0 && (
        <mesh key={i} ref={el => { segRefs.current[i] = el }}
          position={[s.cx, s.cy, -0.001]} rotation={[0, 0, s.angle]}
          onPointerOver={onPointerOver} onPointerOut={onPointerOut}
        >
          <cylinderGeometry args={[1, 1, 1, 8, 1]} />
          <meshBasicMaterial transparent opacity={DEBUG_HIT ? 0.25 : 0} color="#ff6600" depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </>
  )
}

/** Vertex dot with its own independent hover state. Placed as a sibling (not child)
 *  of the edge group so hover does not bubble up and highlight the whole entity. */
/** Square highlight rendered at z=0.001 so it's always visible above lines. */
function VertexHighlight({ x, y, px, color }: { x: number; y: number; px: number; color: string }) {
  const groupRef = useRef<THREE.Group>(null)
  const { camera } = useThree()
  useFrame(() => {
    if (!groupRef.current) return
    groupRef.current.scale.setScalar(px * p2w(camera))
    groupRef.current.quaternion.copy(camera.quaternion)
  })
  const h = 1.4 // half-size of square in local units
  const pts: [number, number, number][] = [[-h, -h, 0], [h, -h, 0], [h, h, 0], [-h, h, 0], [-h, -h, 0]]
  return (
    <group ref={groupRef} position={[x, y, 0]}>
      <Line points={pts} color={color} lineWidth={2} />
    </group>
  )
}

function VertexDot({ x, y, px, baseColor }: { x: number; y: number; px: number; baseColor: string }) {
  const [hovered, setHovered] = useState(false)
  const hitRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  // Offset the hit-sphere toward the camera (not object-space z) so the vertex
  // always wins the raycast over the 3D edge cylinders regardless of orbit angle.
  useFrame(() => {
    if (!hitRef.current) return
    const scale = p2w(camera)
    hitRef.current.scale.setScalar(POINT_HIT_PIXELS * scale)
    // Camera-relative offset: move along view direction toward the camera
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion)
    const off = POINT_HIT_PIXELS_Z_OFFSET * scale
    hitRef.current.position.set(x + fwd.x * off, y + fwd.y * off, fwd.z * off)
  })
  const color = hovered ? COLOR_HOVER : baseColor
  return (
    <group
      onPointerOver={e => { e.stopPropagation(); setHovered(true) }}
      onPointerOut={() => setHovered(false)}
    >
      <Dot x={x} y={y} px={hovered ? px + 2 : px} color={color} billboard />
      {hovered && <VertexHighlight x={x} y={y} px={POINT_HIT_PIXELS * 0.3} color={color} />}
      <mesh ref={hitRef} position={[x, y, 0]}>
        <sphereGeometry args={[1, 8, 8]} />
        <meshBasicMaterial transparent opacity={DEBUG_HIT ? 0.35 : 0} color="#00aaff" depthWrite={false} />
      </mesh>
    </group>
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
      <>
        <group>
          <HitPolyline pts={pts} onPointerOver={onOver} onPointerOut={onOut} />
          {construction
            ? <DashedLine points={pts} color={color} lineWidth={lw} />
            : <Line points={pts} color={color} lineWidth={lw} />}
        </group>
        <VertexDot x={arc.start[0]} y={arc.start[1]} px={4} baseColor={baseColor} />
        <VertexDot x={arc.end[0]} y={arc.end[1]} px={4} baseColor={baseColor} />
        <VertexDot x={arc.center[0]} y={arc.center[1]} px={2.5} baseColor={baseColor} />
      </>
    )
  } else if ('start' in e) {
    const line = e as LineSegment
    const pts: [number, number, number][] = [[line.start[0], line.start[1], 0], [line.end[0], line.end[1], 0]]
    return (
      <>
        <group>
          <HitPolyline pts={pts} onPointerOver={onOver} onPointerOut={onOut} />
          {construction
            ? <DashedLine points={pts} color={color} lineWidth={lw} />
            : <Line points={pts} color={color} lineWidth={lw} />}
        </group>
        <VertexDot x={line.start[0]} y={line.start[1]} px={4} baseColor={baseColor} />
        <VertexDot x={line.end[0]} y={line.end[1]} px={4} baseColor={baseColor} />
      </>
    )
  } else if ('x' in e) {
    const pt = e as PointEntity
    return <VertexDot x={pt.x} y={pt.y} px={5} baseColor={baseColor} />
  } else {
    const circ = e as Circle
    const pts = sampleArc(circ.center[0], circ.center[1], circ.radius, 0, 0)
    return (
      <>
        <group>
          <HitPolyline pts={pts} onPointerOver={onOver} onPointerOut={onOut} />
          {construction
            ? <DashedLine points={pts} color={color} lineWidth={lw} />
            : <Line points={pts} color={color} lineWidth={lw} />}
        </group>
        <VertexDot x={circ.center[0]} y={circ.center[1]} px={2.5} baseColor={baseColor} />
      </>
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
  const color = hovered ? COLOR_HOVER : COLOR_CONSTRAINT
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
  const color = hovered ? COLOR_HOVER : COLOR_CONSTRAINT
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
        <div style={{ color, fontSize: 18, fontFamily: 'monospace', background: '#111', padding: '0 6px', borderRadius: 2, whiteSpace: 'nowrap'}}>
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

// ---------------------------------------------------------------------------
// Topology surface rendering
// ---------------------------------------------------------------------------

interface TopologySurfacesProps {
  topology: Topology
}

type SurfaceShape = { shape: THREE.Shape; pts: [number, number][] }

function buildSurfaceShapes(topology: Topology): SurfaceShape[] {
  return topology.surfaces.flatMap((surface: TopologySurface) => {
    const pts: Point[] = []
    surface.boundary.forEach((edge: TopologyEdge, ei: number) => {
      if (ei === 0) pts.push(edge.start)
      if (edge.kind === 'line') {
        pts.push(edge.end)
      } else {
        const { center, radius, angle_start_deg, angle_end_deg, ccw } = edge as TopologyArcEdge
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
      position={[0, 0, -0.003]}
      onPointerOver={() => setHovered(true)}
      onPointerOut={() => setHovered(false)}
    >
      <shapeGeometry args={[shape]} />
      <meshBasicMaterial color="white" transparent opacity={hovered ? 0.15 : 0.10} side={THREE.DoubleSide} depthWrite={false} />
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

export default function Sketch3D({ solved, constraints, topology }: Sketch3DProps) {
  const extent = useMemo(() => sketchExtent(solved), [solved])

  return (
    <group>
      {topology && <TopologySurfaces topology={topology} />}
      <EntityLines sketch={solved} color={COLOR_SOLVED} lineWidth={2} />
      {constraints && <ConstraintOverlays constraints={constraints} sketch={solved} extent={extent} />}
    </group>
  )
}
