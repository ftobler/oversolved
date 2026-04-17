import { useState, useMemo } from 'react'
import * as THREE from 'three'
import type { Topology, TopologySurface, TopologyEdge, TopologyArcEdge, TopologyEdgeQuery, Point } from '../../types/cad'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { ARC_SEGMENTS, COLOR_HOVER, COLOR_SELECTED, COLOR_INACTIVE } from './constants'
import { surfaceSelectionId, edgeSelectionId } from './utils'

type SurfaceShape = { shape: THREE.Shape; pts: [number, number][]; query: string }

// eslint-disable-next-line react-refresh/only-export-components
export function buildSurfaceShapes(topology: Topology): SurfaceShape[] {
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
    return [{ shape, pts, query: surface.query }]
  })
}

interface SurfaceMeshProps {
  shape: THREE.Shape
  featureId: string
  query: string
  isEditing: boolean
  activeFeatureId?: string
}

export function SurfaceMesh({ shape, featureId, query, isEditing, activeFeatureId }: SurfaceMeshProps) {
  // HOVER PATTERN: Local state for visual feedback (fast), store for logic/debug.
  // DO NOT use local hovered state alone - must also call setHoveredSurface().
  const [hovered, setHovered] = useState(false)
  const toggleNormalSelection = useSketchEditorStore(s => s.toggleNormalSelection)
  const commitPlaneSelection = useSketchEditorStore(s => s.commitPlaneSelection)
  const planeSelectionFeatureId = useSketchEditorStore(s => s.planeSelectionFeatureId)
  const pendingPickField = useSketchEditorStore(s => s.pendingPickField)
  const commitFieldPick = useSketchEditorStore(s => s.commitFieldPick)
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const isRotating = useSketchEditorStore(s => s.isRotating)
  const setHoveredSurface = useSketchEditorStore(s => s.setHoveredSurface)

  const id = surfaceSelectionId(featureId, query)
  const isSelected = normalSelection.has(id)
  const isInactive = activeFeatureId !== undefined && !isEditing

  let color: string = 'white'
  let opacity = 0.10
  if (isInactive) { color = COLOR_INACTIVE; opacity = 0.10 }
  if (isSelected) { color = COLOR_SELECTED; opacity = 0.30 }
  if (hovered) { color = COLOR_HOVER; opacity = 0.20 }

  return (
    <mesh
      position={[0, 0, -0.003]}
      onPointerOver={(e) => { if (isRotating) return; e.stopPropagation(); setHovered(true); setHoveredSurface(id) }}
      onPointerOut={() => { if (isRotating) return; setHovered(false); setHoveredSurface(null) }}
      onClick={(e) => {
        e.stopPropagation()
        if (planeSelectionFeatureId) commitPlaneSelection(id)
        else {
          toggleNormalSelection(id)
          if (pendingPickField) commitFieldPick()
        }
      }}
    >
      <shapeGeometry args={[shape]} />
      <meshBasicMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  )
}

interface EdgeMeshProps {
  edge: TopologyEdgeQuery
  featureId: string
}

function EdgeMesh({ edge, featureId }: EdgeMeshProps) {
  const [hovered, setHovered] = useState(false)
  const toggleNormalSelection = useSketchEditorStore(s => s.toggleNormalSelection)
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const isRotating = useSketchEditorStore(s => s.isRotating)
  const setHoveredEdge = useSketchEditorStore(s => s.setHoveredEdge)

  const id = edgeSelectionId(featureId, edge.query)
  const isSelected = normalSelection.has(id)

  const color = isSelected ? COLOR_SELECTED : (hovered ? COLOR_HOVER : 'white')

  const start = edge.start
  const end = edge.end

  // Hoisted before conditional return to satisfy rules-of-hooks.
  const lineGeometry = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([...start, ...end]), 3))
    return geo
  }, [start, end])

  if (edge.kind === 'arc' && edge.center && edge.radius !== undefined) {
    const cx = edge.center[0]
    const cy = edge.center[1]
    const r = edge.radius
    const a0 = edge.angle_start_deg ?? 0
    const a1 = edge.angle_end_deg ?? 0

    const curve = new THREE.EllipseCurve(cx, cy, r, r, (a0 * Math.PI) / 180, (a1 * Math.PI) / 180, false, 0)
    const points = curve.getPoints(32)
    const arcGeometry = new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(p.x, p.y, 0)))

    return (
      <line
        onPointerOver={(e) => { if (isRotating) return; e.stopPropagation(); setHovered(true); setHoveredEdge(id) }}
        onPointerOut={() => { if (isRotating) return; setHovered(false); setHoveredEdge(null) }}
        onClick={(e) => { e.stopPropagation(); toggleNormalSelection(id) }}
      >
        <primitive object={arcGeometry} attach="geometry" />
        <lineBasicMaterial color={color} linewidth={2} />
      </line>
    )
  }

  return (
    <line
      onPointerOver={(e) => { if (isRotating) return; e.stopPropagation(); setHovered(true); setHoveredEdge(id) }}
      onPointerOut={() => { if (isRotating) return; setHovered(false); setHoveredEdge(null) }}
      onClick={(e) => { e.stopPropagation(); toggleNormalSelection(id) }}
    >
      <primitive object={lineGeometry} attach="geometry" />
      <lineBasicMaterial color={color} linewidth={2} />
    </line>
  )
}

interface TopologyEdgesProps {
  topology: Topology
  featureId: string
}

export function TopologyEdges({ topology, featureId }: TopologyEdgesProps) {
  const edges = topology.edges ?? []
  return (
    <>
      {edges.map((edge, ei) => (
        <EdgeMesh key={ei} edge={edge} featureId={featureId} />
      ))}
    </>
  )
}

interface TopologySurfacesProps {
  topology: Topology
  featureId: string
  isEditing: boolean
  activeFeatureId?: string
}

export function TopologySurfaces({ topology, featureId, isEditing, activeFeatureId }: TopologySurfacesProps) {
  const surfaces = useMemo(() => buildSurfaceShapes(topology), [topology])
  return (
    <>
      {surfaces.map((s, si) => (
        <SurfaceMesh
          key={si}
          shape={s.shape}
          featureId={featureId}
          query={s.query}
          isEditing={isEditing}
          activeFeatureId={activeFeatureId}
        />
      ))}
    </>
  )
}
