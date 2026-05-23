import { useMemo } from 'react'
import * as THREE from 'three'
import type { ThreeEvent } from '@react-three/fiber'
import type { Topology, TopologySurface, TopologyEdge, TopologyArcEdge, TopologyEdgeQuery, Point } from '@/types/cad'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { ARC_SEGMENTS, COLOR_SELECTED, COLOR_INACTIVE } from '@/components/Geometry3D/constants'
import { surfaceSelectionId, edgeSelectionId } from '@/components/Geometry3D/utils'

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

// 'inactive' = another sketch is being edited (this one is dimmed, no events)
// 'editing'  = this sketch is being edited (ID buffer owns entity/vertex events)
// 'view'     = no sketch is being edited (R3F mesh events handle selection)
export type TopologyMode = 'view' | 'editing' | 'inactive'

interface SurfaceMeshProps {
  shape: THREE.Shape
  featureId: string
  query: string
  mode: TopologyMode
}

export function SurfaceMesh({ shape, featureId, query, mode }: SurfaceMeshProps) {
  const toggleNormalSelection = useSketchEditorStore(s => s.toggleNormalSelection)
  const commitPlaneSelection = useSketchEditorStore(s => s.commitPlaneSelection)
  const planeSelectionFeatureId = useSketchEditorStore(s => s.planeSelectionFeatureId)
  const normalSelection = useSketchEditorStore(s => s.normalSelection)

  const id = surfaceSelectionId(featureId, query)
  const isSelected = normalSelection.has(id)

  let color: string = 'white'
  let opacity = 0.10
  if (mode === 'inactive') { color = COLOR_INACTIVE; opacity = 0.10 }
  if (isSelected) { color = COLOR_SELECTED; opacity = 0.30 }

  // In editing mode the ID buffer owns entity/vertex clicks. stopPropagation
  // is still required to prevent the background DrawPlane from clearing the
  // ID-buffer selection. toggleNormalSelection is only allowed in view mode.
  const handleClick = mode === 'inactive' ? undefined : (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    if (planeSelectionFeatureId) commitPlaneSelection(id)
    else if (mode === 'view') toggleNormalSelection(id)
  }

  return (
    <mesh
      position={[0, 0, -0.003]}
      onClick={handleClick}
    >
      <shapeGeometry args={[shape]} />
      <meshBasicMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  )
}

interface EdgeMeshProps {
  edge: TopologyEdgeQuery
  featureId: string
  mode: TopologyMode
}

function _isValidPoint(p: Point): boolean {
  return Number.isFinite(p[0]) && Number.isFinite(p[1])
}

function EdgeMesh({ edge, featureId, mode }: EdgeMeshProps) {
  const toggleNormalSelection = useSketchEditorStore(s => s.toggleNormalSelection)
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const id = edgeSelectionId(featureId, edge.query)
  const isSelected = normalSelection.has(id)

  const color = isSelected ? COLOR_SELECTED : 'white'

  const start = edge.start
  const end = edge.end

  // Hoisted before conditional return to satisfy rules-of-hooks.
  const lineGeometry = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    const validS = _isValidPoint(start)
    const validE = _isValidPoint(end)
    if (validS && validE) {
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([start[0], start[1], 0, end[0], end[1], 0]), 3))
    } else if (validS) {
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([start[0], start[1], 0]), 3))
    } else if (validE) {
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([end[0], end[1], 0]), 3))
    } else {
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 3))
    }
    return geo
  }, [start, end])

  // Same rule as SurfaceMesh: stopPropagation always (protects ID-buffer selection
  // from DrawPlane clear), but toggleNormalSelection only in view mode.
  const handleEdgeClick = mode === 'inactive' ? undefined : (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    if (mode === 'view') toggleNormalSelection(id)
  }

  if (edge.kind === 'arc' && edge.center && edge.radius !== undefined) {
    const cx = edge.center[0]
    const cy = edge.center[1]
    const r = edge.radius
    const a0 = edge.angle_start_deg ?? 0
    const a1 = edge.angle_end_deg ?? 0

    if (Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(r) && Number.isFinite(a0) && Number.isFinite(a1)) {
      const curve = new THREE.EllipseCurve(cx, cy, r, r, (a0 * Math.PI) / 180, (a1 * Math.PI) / 180, false, 0)
      const points = curve.getPoints(32)
      const arcGeometry = new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(p.x, p.y, 0)))

      return (
        <line onClick={handleEdgeClick}>
          <primitive object={arcGeometry} attach="geometry" />
          <lineBasicMaterial color={color} linewidth={2} />
        </line>
      )
    }
  }

  return (
    <line onClick={handleEdgeClick}>
      <primitive object={lineGeometry} attach="geometry" />
      <lineBasicMaterial color={color} linewidth={2} />
    </line>
  )
}

interface TopologyEdgesProps {
  topology: Topology
  featureId: string
  isEditing: boolean
  activeFeatureId?: string
}

export function TopologyEdges({ topology, featureId, isEditing, activeFeatureId }: TopologyEdgesProps) {
  const edges = topology.edges ?? []
  const mode: TopologyMode = activeFeatureId !== undefined ? (isEditing ? 'editing' : 'inactive') : 'view'
  return (
    <>
      {edges.map((edge, ei) => (
        <EdgeMesh key={ei} edge={edge} featureId={featureId} mode={mode} />
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
  const mode: TopologyMode = activeFeatureId !== undefined ? (isEditing ? 'editing' : 'inactive') : 'view'
  return (
    <>
      {surfaces.map((s, si) => (
        <SurfaceMesh
          key={si}
          shape={s.shape}
          featureId={featureId}
          query={s.query}
          mode={mode}
        />
      ))}
    </>
  )
}
