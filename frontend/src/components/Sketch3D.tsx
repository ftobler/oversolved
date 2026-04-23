import { useRef, useMemo, useState } from 'react'
import { Line } from '@react-three/drei'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Sketch, Constraints, Topology, Point, TopologySurface, TopologyEdge, TopologyArcEdge, Entity, LineSegment, Circle, Arc, PointEntity } from '../types/cad'
import { p2w, sampleArc, getEntityBounds } from './sketch_helpers'
import { DashedLine, ConstraintOverlays } from './sketch_dimensions'
import { useSketchEditorStore } from '../stores/sketchEditorStore'

const COLOR_SOLVED = '#4fc3f7'
const COLOR_HOVER = '#ffffff'
const ARC_SEGMENTS = 64

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
// Square highlight rendered at z=0.001 so it's always visible above lines.
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
  // NOTE: This is the 2D SVG-based sketch view - uses local state only.
  // Different rendering context from the 3D canvas components.
  const [hovered, setHovered] = useState(false)
  const hitRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  const isRotating = useSketchEditorStore(s => s.isRotating)
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
      onPointerOver={e => { if (isRotating) return; e.stopPropagation(); setHovered(true) }}
      onPointerOut={() => { if (isRotating) return; setHovered(false) }}
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

function sketchExtent(sketch: Sketch): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const entity of Object.values(sketch)) {
    const b = getEntityBounds(entity as Entity)
    minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX)
    minY = Math.min(minY, b.minY); maxY = Math.max(maxY, b.maxY)
  }
  return isFinite(minX) ? Math.max(maxX - minX, maxY - minY, 0.01) : 1
}

// ----
// Entity rendering
// ----

interface EntityItemProps {
  entity: Entity
  baseColor: string
  lineWidth?: number
}

function EntityItem({ entity, baseColor, lineWidth = 1 }: EntityItemProps) {
  // NOTE: This is the 2D SVG-based sketch view - uses local state only.
  // Different rendering context from the 3D canvas components.
  const [hovered, setHovered] = useState(false)
  const isRotating = useSketchEditorStore(s => s.isRotating)
  const color = hovered ? COLOR_HOVER : baseColor
  const lw = hovered ? lineWidth + 1 : lineWidth
  const e = entity
  const construction = 'construction' in e && e.construction
  const onOver = (ev: { stopPropagation: () => void }) => { if (isRotating) return; ev.stopPropagation(); setHovered(true) }
  const onOut = () => { if (isRotating) return; setHovered(false) }

  if ('start' in e && 'end' in e && 'radius' in e) {
    const arc = e as Arc
    const pts = sampleArc(arc.center[0], arc.center[1], arc.radius, arc.angle_start, arc.angle_end)
    return (
      <>
        <group>
          <HitPolyline pts={pts} onPointerOver={onOver} onPointerOut={onOut} />
          {construction
            ? <DashedLine points={pts} color={color} lineWidth={lw} />
            : <Line points={pts} color={color} lineWidth={lw} depthTest={false} />}
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
            : <Line points={pts} color={color} lineWidth={lw} depthTest={false} />}
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
            : <Line points={pts} color={color} lineWidth={lw} depthTest={false} />}
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

// ----
// Topology surface rendering
// ----

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
  // NOTE: This is the 2D SVG-based sketch view - uses local state only.
  // Different rendering context from the 3D canvas components.
  const [hovered, setHovered] = useState(false)
  const isRotating = useSketchEditorStore(s => s.isRotating)
  return (
    <mesh
      position={[0, 0, -0.003]}
      onPointerOver={() => { if (isRotating) return; setHovered(true) }}
      onPointerOut={() => { if (isRotating) return; setHovered(false) }}
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

// ----
// Main component
// ----

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
