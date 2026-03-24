import { useRef, useMemo, useState, useCallback } from 'react'
import { Line, Html } from '@react-three/drei'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Sketch, Constraints, Topology, Point, TopologySurface, TopologyEdge, TopologyArcEdge, Entity, LineSegment, Circle, Arc, PointEntity } from '../types/cad'
import { useSketchEditorStore } from '../stores/sketchEditorStore'
import { p2w, sampleArc, getEntityBounds, ICON_SIZE, ICON_COLS, getIconUrl } from './sketch_helpers'
import { DashedLine, LinearDimension, RadiusDimension, DiameterDimension, AngleDimension } from './sketch_dimensions'

const COLOR_SOLVED = '#4fc3f7'
const COLOR_HOVER = '#ffffff'
const COLOR_SELECTED = '#ff9800'
const COLOR_CONSTRAINT_HOVER = '#fff176'  // entity highlighted because a constraint on it is hovered
const COLOR_PREVIEW = '#aaaaaa'
const ARC_SEGMENTS = 64

/** 10-gon dot with constant pixel radius regardless of zoom.
 *  If billboard=true the dot always faces the camera. */
function Dot({ x, y, px, color, billboard = false }: { x: number; y: number; px: number; color: string; billboard?: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  useFrame(() => {
    if (!meshRef.current) return
    meshRef.current.scale.setScalar(px * p2w(camera))
    if (billboard) {
      // Billboard in world space: undo parent world rotation before applying camera quaternion
      const parentQuat = new THREE.Quaternion()
      meshRef.current.parent?.getWorldQuaternion(parentQuat)
      meshRef.current.quaternion.copy(camera.quaternion).premultiply(parentQuat.invert())
    }
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
/** Square highlight rendered at z=0.001 so it's always visible above lines. */
function VertexHighlight({ x, y, px, color }: { x: number; y: number; px: number; color: string }) {
  const groupRef = useRef<THREE.Group>(null)
  const { camera } = useThree()
  useFrame(() => {
    if (!groupRef.current) return
    groupRef.current.scale.setScalar(px * p2w(camera))
    // Billboard in world space: undo parent world rotation before applying camera quaternion
    const parentQuat = new THREE.Quaternion()
    groupRef.current.parent?.getWorldQuaternion(parentQuat)
    groupRef.current.quaternion.copy(camera.quaternion).premultiply(parentQuat.invert())
  })
  const h = 1.4 // half-size of square in local units
  const pts: [number, number, number][] = [[-h, -h, 0], [h, -h, 0], [h, h, 0], [-h, h, 0], [-h, -h, 0]]
  return (
    <group ref={groupRef} position={[x, y, 0]}>
      <Line points={pts} color={color} lineWidth={2} />
    </group>
  )
}

function VertexDot({ x, y, px, baseColor, featureId, entityId, vertexKey }: {
  x: number; y: number; px: number; baseColor: string
  featureId?: string; entityId?: string; vertexKey?: string
}) {
  const [hovered, setHovered] = useState(false)
  const hitRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  const vertId = featureId && entityId && vertexKey ? `vertex:${featureId}:${entityId}:${vertexKey}` : undefined
  const selected = useSketchEditorStore(s => vertId ? s.selection.has(vertId) : false)
  const toggleSelect = useSketchEditorStore(s => s.toggleSelect)
  const setDrag = useSketchEditorStore(s => s.setDrag)
  const setOrbitEnabled = useSketchEditorStore(s => s.setOrbitEnabled)
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const handleDimClick = useSketchEditorStore(s => s.handleDimensionClick)
  const constraintHovered = useSketchEditorStore(s =>
    entityId && vertexKey ? s.hoveredConstraintEntityIds.has(`${entityId}:${vertexKey}`) : false
  )
  // Offset the hit-sphere toward the camera (not object-space z) so the vertex
  // always wins the raycast over the 3D edge cylinders regardless of orbit angle.
  useFrame(() => {
    if (!hitRef.current) return
    const scale = p2w(camera)
    hitRef.current.scale.setScalar(POINT_HIT_PIXELS * scale)
    // Camera view direction in world space, transformed into local (sketch plane) space
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion)
    const parentQuat = new THREE.Quaternion()
    hitRef.current.parent?.getWorldQuaternion(parentQuat)
    fwd.applyQuaternion(parentQuat.invert())
    const off = POINT_HIT_PIXELS_Z_OFFSET * scale
    hitRef.current.position.set(x + fwd.x * off, y + fwd.y * off, fwd.z * off)
  })
  const onClick = useCallback((e: { stopPropagation: () => void }) => {
    if (!vertId || !featureId) return
    e.stopPropagation()
    if (activeTool === 'dimension') {
      handleDimClick(vertId, featureId, 'vertex')
    } else {
      toggleSelect(vertId)
    }
  }, [vertId, featureId, toggleSelect, activeTool, handleDimClick])
  const onPointerDown = useCallback((e: { stopPropagation: () => void; point: THREE.Vector3 }) => {
    if (!vertId || !featureId || !entityId || !vertexKey) return
    if (activeTool !== 'select') return
    e.stopPropagation()
    setOrbitEnabled(false)
    setDrag({
      type: 'vertex',
      vertexId: vertId,
      featureId,
      entityId,
      vertexKey,
      startWorld: [x, y],
      currentWorld: [x, y],
    })
  }, [vertId, featureId, entityId, vertexKey, x, y, setDrag, setOrbitEnabled, activeTool])
  const color = hovered ? COLOR_HOVER : selected ? COLOR_SELECTED : constraintHovered ? COLOR_CONSTRAINT_HOVER : baseColor
  return (
    <group
      onPointerOver={e => { e.stopPropagation(); setHovered(true) }}
      onPointerOut={() => setHovered(false)}
      onClick={onClick}
      onPointerDown={onPointerDown}
    >
      <Dot x={x} y={y} px={hovered ? px + 2 : px} color={color} billboard />
      {(hovered || selected || constraintHovered) && <VertexHighlight x={x} y={y} px={POINT_HIT_PIXELS * 0.3} color={color} />}
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
  entityId: string
  featureId: string
  baseColor: string
  lineWidth?: number
}

function EntityItem({ entity, entityId, featureId, baseColor, lineWidth = 1 }: EntityItemProps) {
  const [hovered, setHovered] = useState(false)
  const entId = `entity:${featureId}:${entityId}`
  const selected = useSketchEditorStore(s => s.selection.has(entId))
  const constraintHovered = useSketchEditorStore(s => s.hoveredConstraintEntityIds.has(entityId))
  const toggleSelect = useSketchEditorStore(s => s.toggleSelect)
  const setDrag = useSketchEditorStore(s => s.setDrag)
  const setOrbitEnabled = useSketchEditorStore(s => s.setOrbitEnabled)
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const handleDimClick = useSketchEditorStore(s => s.handleDimensionClick)
  const color = hovered ? COLOR_HOVER
    : selected ? COLOR_SELECTED
    : constraintHovered ? COLOR_CONSTRAINT_HOVER
    : baseColor
  const lw = hovered ? lineWidth + 1 : lineWidth
  const e = entity
  const construction = 'construction' in e && e.construction
  const onOver = (ev: { stopPropagation: () => void }) => { ev.stopPropagation(); setHovered(true) }
  const onOut = () => setHovered(false)
  const onClick = useCallback((ev: { stopPropagation: () => void }) => {
    ev.stopPropagation()
    if (activeTool === 'dimension') {
      const isArc = 'start' in e && 'end' in e && 'radius' in e
      const isCircle = !isArc && 'radius' in e
      const entityKind = isArc ? 'arc' : isCircle ? 'circle' : 'line_segment'
      handleDimClick(`entity:${featureId}:${entityId}`, featureId, 'entity', entityKind)
    } else {
      toggleSelect(entId)
    }
  }, [entId, toggleSelect, activeTool, handleDimClick, featureId, entityId, e])
  // Edge drag: pointer down on the edge group initiates a full-entity move
  const onPointerDown = useCallback((ev: { stopPropagation: () => void; point: { x: number; y: number } }) => {
    if (activeTool !== 'select') return
    ev.stopPropagation()
    setOrbitEnabled(false)
    setDrag({ type: 'edge', vertexId: entId, featureId, entityId,
      vertexKey: 'edge', startWorld: [ev.point.x, ev.point.y], currentWorld: [ev.point.x, ev.point.y] })
  }, [entId, featureId, entityId, setDrag, setOrbitEnabled, activeTool])

  if ('start' in e && 'end' in e && 'radius' in e) {
    const arc = e as Arc
    const pts = sampleArc(arc.center[0], arc.center[1], arc.radius, arc.angle_start, arc.angle_end)
    return (
      <>
        <group onClick={onClick} onPointerDown={onPointerDown}>
          <HitPolyline pts={pts} onPointerOver={onOver} onPointerOut={onOut} />
          {construction
            ? <DashedLine points={pts} color={color} lineWidth={lw} />
            : <Line points={pts} color={color} lineWidth={lw} />}
        </group>
        <VertexDot x={arc.start[0]} y={arc.start[1]} px={4} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="start" />
        <VertexDot x={arc.end[0]} y={arc.end[1]} px={4} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="end" />
        <VertexDot x={arc.center[0]} y={arc.center[1]} px={2.5} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="center" />
      </>
    )
  } else if ('start' in e) {
    const line = e as LineSegment
    const pts: [number, number, number][] = [[line.start[0], line.start[1], 0], [line.end[0], line.end[1], 0]]
    return (
      <>
        <group onClick={onClick} onPointerDown={onPointerDown}>
          <HitPolyline pts={pts} onPointerOver={onOver} onPointerOut={onOut} />
          {construction
            ? <DashedLine points={pts} color={color} lineWidth={lw} />
            : <Line points={pts} color={color} lineWidth={lw} />}
        </group>
        <VertexDot x={line.start[0]} y={line.start[1]} px={4} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="start" />
        <VertexDot x={line.end[0]} y={line.end[1]} px={4} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="end" />
      </>
    )
  } else if ('x' in e) {
    const pt = e as PointEntity
    return <VertexDot x={pt.x} y={pt.y} px={5} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="xy" />
  } else {
    const circ = e as Circle
    const pts = sampleArc(circ.center[0], circ.center[1], circ.radius, 0, 0)
    return (
      <>
        <group onClick={onClick} onPointerDown={onPointerDown}>
          <HitPolyline pts={pts} onPointerOver={onOver} onPointerOut={onOut} />
          {construction
            ? <DashedLine points={pts} color={color} lineWidth={lw} />
            : <Line points={pts} color={color} lineWidth={lw} />}
        </group>
        <VertexDot x={circ.center[0]} y={circ.center[1]} px={2.5} baseColor={baseColor} featureId={featureId} entityId={entityId} vertexKey="center" />
      </>
    )
  }
}

interface EntityLinesProps {
  sketch: Sketch
  featureId: string
  color: string
  lineWidth?: number
}

function EntityLines({ sketch, featureId, color, lineWidth = 1 }: EntityLinesProps) {
  return (
    <>
      {Object.entries(sketch).map(([id, entity]) => (
        <EntityItem key={id} entity={entity as Entity} entityId={id} featureId={featureId} baseColor={color} lineWidth={lineWidth} />
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// Constraint rendering
// ---------------------------------------------------------------------------

/** Find all entity IDs in the sketch that have a vertex at the given point (within eps). */
function findEntitiesAtPoint(sketch: Sketch, pt: [number, number], eps = 1e-4): string[] {
  const [px, py] = pt
  const near = (x: number, y: number) => Math.abs(x - px) <= eps && Math.abs(y - py) <= eps
  const ids: string[] = []
  for (const [eid, entity] of Object.entries(sketch)) {
    const e = entity as Entity
    if ('start' in e && 'end' in e) {
      if (near(e.start[0], e.start[1]) || near(e.end[0], e.end[1])) ids.push(eid)
    } else if ('x' in e) {
      if (near(e.x, e.y)) ids.push(eid)
    } else if ('center' in e) {
      if (near(e.center[0], e.center[1])) ids.push(eid)
    }
  }
  return ids
}

function ConstraintTile({ url, id, featureId, highlightIds, superfluous }: { url: string; id: string; featureId: string; highlightIds: string[]; superfluous?: boolean }) {
  const [hovered, setHovered] = useState(false)
  const cId = `constraint:${featureId}:${id}`
  const selected = useSketchEditorStore(s => s.selection.has(cId))
  const toggleSelect = useSketchEditorStore(s => s.toggleSelect)
  const setHoveredConstraintEntities = useSketchEditorStore(s => s.setHoveredConstraintEntities)

  const bg_color = selected ? COLOR_SELECTED : hovered ? '#4e4e4e' : superfluous ? '#2a1f00' : '#1C1C1C'
  const fg_style = (hovered || selected) ? 'invert(1.0)' : superfluous ? 'invert(0.5) sepia(1) saturate(3) hue-rotate(0deg)' : 'invert(0.7)'
  return (
    <div
      key={id}
      onMouseEnter={() => { setHovered(true); setHoveredConstraintEntities(new Set(highlightIds)) }}
      onMouseLeave={() => { setHovered(false); setHoveredConstraintEntities(new Set()) }}
      onClick={(e) => { e.stopPropagation(); toggleSelect(cId) }}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        width: ICON_SIZE,
        height: ICON_SIZE,
        background: bg_color,
        borderRadius: 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        cursor: 'pointer',
        ...(superfluous && { outline: '1px solid #b37400' }),
      }}
    >
      <img
        src={url}
        width={ICON_SIZE - 4}
        height={ICON_SIZE - 4}
        style={{filter: fg_style}}
      />
    </div>
  )
}


interface ConstraintOverlaysProps {
  constraints: Constraints
  sketch: Sketch
  extent: number
  featureId: string
}

function ConstraintOverlays({ constraints, sketch, extent, featureId }: ConstraintOverlaysProps) {
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

    // Sub-group symbols by their `at` position so each distinct location gets its own Html anchor.
    // Key is a rounded grid string; value holds the canonical position and its icon list.
    const atGroups = new Map<string, { at: [number, number]; icons: { url: string; key: string; highlightIds: string[]; superfluous?: boolean }[] }>()

    for (const [cid, c] of clist) {
      const r = c.render as { kind: string; at?: [number, number]; point?: string; entities?: string[]; [key: string]: unknown }

      if (r.kind.startsWith('symbol_')) {
        const url = getIconUrl(r.kind)
        if (!url) continue
        const at: [number, number] = r.at ?? [bounds.maxX, bounds.maxY]
        const atKey = `${Math.round(at[0] * 1000)}_${Math.round(at[1] * 1000)}`
        if (!atGroups.has(atKey)) atGroups.set(atKey, { at, icons: [] })

        // Determine which ids to highlight on hover:
        //   - vertex-targeted constraint (e.g. fixed on $line1start): highlight just that vertex
        //   - multi-entity constraint: highlight all involved entities
        //   - proximity fallback: entities sharing the `at` point
        //   - last resort: the owning entity
        let highlightIds: string[]
        if (r.point != null) {
          // Vertex-targeted (e.g. fixed on a specific endpoint) — use "entityId:vertexKey" format
          highlightIds = [`${eid}:${r.point}`]
        } else if (r.entities?.length) {
          highlightIds = r.entities
        } else {
          const atEntities = findEntitiesAtPoint(sketch, at)
          highlightIds = atEntities.length > 0 ? atEntities : [eid]
        }
        atGroups.get(atKey)!.icons.push({ url, key: cid, highlightIds, superfluous: c.superfluous })

      } else if (r.kind === 'dim_linear') {
        const dim = r as { kind: string; p1: [number, number]; p2: [number, number]; normal: [number, number]; value: number }
        dimElements.push(<LinearDimension key={cid} cid={cid} dim={dim} dimOffset={dimOffset} interaction={{ featureId, entityId: eid, promptLabel: 'dimension' }} />)

      } else if (r.kind === 'dim_radius') {
        const dim = r as { kind: string; p1: [number, number]; p2: [number, number]; value: number }
        dimElements.push(<RadiusDimension key={cid} cid={cid} dim={dim} interaction={{ featureId, entityId: eid, promptLabel: 'radius' }} />)

      } else if (r.kind === 'dim_diameter') {
        const dim = r as { kind: string; p1: [number, number]; p2: [number, number]; value: number }
        dimElements.push(<DiameterDimension key={cid} cid={cid} dim={dim} interaction={{ featureId, entityId: eid, promptLabel: 'diameter' }} />)

      } else if (r.kind === 'dim_angle') {
        const dim = r as { kind: string; p1: [number, number]; p2: [number, number]; p3?: [number, number]; value: number }
        if (!dim.p3) continue
        dimElements.push(<AngleDimension key={cid} cid={cid} dim={dim} interaction={{ featureId, entityId: eid, promptLabel: 'angle in degrees' }} />)
      }
    }

    for (const [atKey, { at, icons }] of atGroups) {
      const colWidth = ICON_SIZE + 2
      const groupWidth = Math.min(ICON_COLS, icons.length) * colWidth
      symbolElements.push(
        <Html key={`icons-${eid}-${atKey}`} position={[at[0], at[1], 0.001]} style={{ pointerEvents: 'auto' }}>
          <div style={{ marginLeft: 20, marginTop: -8, display: 'flex', flexWrap: 'wrap', width: groupWidth, gap: 2 }}>
            {icons.map(({ url, key, highlightIds, superfluous }) => (
              <ConstraintTile key={key} url={url} id={key} featureId={featureId} highlightIds={highlightIds} superfluous={superfluous} />
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
// DragPlane — large invisible plane that captures pointer during vertex drag
// ---------------------------------------------------------------------------

function DragPlane() {
  const drag = useSketchEditorStore(s => s.drag)
  const setDrag = useSketchEditorStore(s => s.setDrag)
  const setOrbitEnabled = useSketchEditorStore(s => s.setOrbitEnabled)
  const onMutation = useSketchEditorStore(s => s.onMutation)

  if (!drag) return null

  return (
    <mesh
      position={[0, 0, 0.01]}
      onPointerMove={(e) => {
        e.stopPropagation()
        setDrag({ ...drag, currentWorld: [e.point.x, e.point.y] })
      }}
      onPointerUp={(e) => {
        e.stopPropagation()
        if (onMutation) {
          if (drag.type === 'edge') {
            // Fire move_entity with total delta from drag start
            const delta: [number, number] = [
              drag.currentWorld[0] - drag.startWorld[0],
              drag.currentWorld[1] - drag.startWorld[1],
            ]
            onMutation({ type: 'move_entity', featureId: drag.featureId, entityId: drag.entityId, delta })
          } else {
            onMutation({ type: 'move_vertex', featureId: drag.featureId,
              entityId: drag.entityId, vertexKey: drag.vertexKey, to: drag.currentWorld })
          }
        }
        setDrag(null)
        setOrbitEnabled(true)
      }}
    >
      <planeGeometry args={[10000, 10000]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  )
}

// ---------------------------------------------------------------------------
// Draw plane — captures pointer for entity insertion when a drawing tool is active
// ---------------------------------------------------------------------------

/** Compute circumcircle of 3 points. Returns null if points are collinear. */
function circumcircle(p1: [number, number], p2: [number, number], p3: [number, number]): { cx: number; cy: number; r: number } | null {
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

/**
 * Given arc start and end angles (degrees) and a radius point, determine the CCW arc.
 * Returns [aStart, aEnd] such that going CCW from aStart reaches aEnd.
 * The radius point determines which arc (short or long) was intended.
 */
function arcAnglesFromRadiusPoint(
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

function computePreviewPts(
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
  return null
}

function DrawPreview({ featureId, activeFeatureId }: { featureId: string; activeFeatureId?: string }) {
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

function DrawPlane({ featureId, activeFeatureId }: { featureId: string; activeFeatureId?: string }) {
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
        onMutation?.({ type: 'add_entity', featureId, kind: 'line_segment',
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

// Apply drag offset to sketch for optimistic preview
function applyDragPreview(sketch: Sketch, drag: { type?: string; entityId: string; vertexKey: string; startWorld: [number, number]; currentWorld: [number, number] }): Sketch {
  const dx = drag.currentWorld[0] - drag.startWorld[0]
  const dy = drag.currentWorld[1] - drag.startWorld[1]
  if (dx === 0 && dy === 0) return sketch
  const result = structuredClone(sketch)
  const entity = result[drag.entityId]
  if (!entity) return sketch

  if (drag.type === 'edge') {
    // Translate the entire entity by delta
    if ('start' in entity && 'end' in entity) {
      const l = entity as LineSegment
      l.start = [l.start[0] + dx, l.start[1] + dy]
      l.end = [l.end[0] + dx, l.end[1] + dy]
    } else if ('center' in entity) {
      const c = entity as Circle | Arc
      c.center = [c.center[0] + dx, c.center[1] + dy]
    } else if ('x' in entity) {
      const p = entity as PointEntity
      p.x += dx; p.y += dy
    }
    return result
  }

  const key = drag.vertexKey
  if ('start' in entity && 'end' in entity && 'radius' in entity && key === 'start') {
    (entity as Arc).start = [drag.currentWorld[0], drag.currentWorld[1]]
  } else if ('start' in entity && 'end' in entity && 'radius' in entity && key === 'end') {
    (entity as Arc).end = [drag.currentWorld[0], drag.currentWorld[1]]
  } else if ('start' in entity && 'end' in entity && key === 'start') {
    (entity as LineSegment).start = [drag.currentWorld[0], drag.currentWorld[1]]
  } else if ('start' in entity && 'end' in entity && key === 'end') {
    (entity as LineSegment).end = [drag.currentWorld[0], drag.currentWorld[1]]
  } else if ('center' in entity && key === 'center') {
    (entity as Circle | Arc).center = [drag.currentWorld[0], drag.currentWorld[1]]
  } else if ('x' in entity && key === 'xy') {
    (entity as PointEntity).x = drag.currentWorld[0];
    (entity as PointEntity).y = drag.currentWorld[1]
  }
  return result
}

// Euler rotations (XYZ) for each built-in sketch plane.
const BUILTIN_PLANE_ROTATIONS: Record<string, [number, number, number]> = {
  'builtin_plane_front': [0, 0, 0],
  'builtin_plane_top':   [-Math.PI / 2, 0, 0],
  'builtin_plane_right': [0, Math.PI / 2, 0],
}

function planeRotation(planeQuery: string | undefined): [number, number, number] {
  if (!planeQuery) return [0, 0, 0]
  const id = planeQuery.startsWith('@') ? planeQuery.slice(1) : planeQuery
  return BUILTIN_PLANE_ROTATIONS[id] ?? [0, 0, 0]
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface Geometry3DProps {
  featureId: string
  solved: Sketch
  constraints?: Constraints
  topology?: Topology
  activeFeatureId?: string
  plane?: string
}

export default function Geometry3D({ featureId, solved, constraints, topology, activeFeatureId, plane }: Geometry3DProps) {
  const drag = useSketchEditorStore(s => s.drag)
  // During drag on this feature, show optimistic preview
  const displaySketch = useMemo(() => {
    if (drag && drag.featureId === featureId) return applyDragPreview(solved, drag)
    return solved
  }, [solved, drag, featureId])
  const extent = useMemo(() => sketchExtent(displaySketch), [displaySketch])
  const rot = planeRotation(plane)

  return (
    <group rotation={rot}>
      {topology && <TopologySurfaces topology={topology} />}
      <EntityLines sketch={displaySketch} featureId={featureId} color={COLOR_SOLVED} lineWidth={2} />
      {constraints && <ConstraintOverlays constraints={constraints} sketch={displaySketch} extent={extent} featureId={featureId} />}
      <DragPlane />
      <DrawPreview featureId={featureId} activeFeatureId={activeFeatureId} />
      <DrawPlane featureId={featureId} activeFeatureId={activeFeatureId} />
    </group>
  )
}
