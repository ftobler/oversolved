import { useState, useMemo } from 'react'
import * as THREE from 'three'
import type { Topology, TopologySurface, TopologyEdge, TopologyArcEdge, Point } from '../../types/cad'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { ARC_SEGMENTS, COLOR_HOVER, COLOR_SELECTED, COLOR_INACTIVE } from './constants'
import { surfaceSelectionId } from './utils'

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
  const [hovered, setHovered] = useState(false)
  const toggleSelect = useSketchEditorStore(s => s.toggleSelect)
  const commitPlaneSelection = useSketchEditorStore(s => s.commitPlaneSelection)
  const planeSelectionFeatureId = useSketchEditorStore(s => s.planeSelectionFeatureId)
  const fieldPickState = useSketchEditorStore(s => s.fieldPickState)
  const commitFieldPick = useSketchEditorStore(s => s.commitFieldPick)
  const selection = useSketchEditorStore(s => s.selection)

  const id = surfaceSelectionId(featureId, query)
  const isSelected = selection.has(id)
  const isInactive = activeFeatureId !== undefined && !isEditing

  let color: string = 'white'
  let opacity = 0.10
  if (isInactive) { color = COLOR_INACTIVE; opacity = 0.10 }
  if (isSelected) { color = COLOR_SELECTED; opacity = 0.30 }
  if (hovered) { color = COLOR_HOVER; opacity = 0.20 }

  return (
    <mesh
      position={[0, 0, -0.003]}
      onPointerOver={(e) => { e.stopPropagation(); setHovered(true) }}
      onPointerOut={() => setHovered(false)}
      onClick={(e) => {
        e.stopPropagation()
        if (fieldPickState?.kind === 'plane') commitFieldPick(id)
        else if (planeSelectionFeatureId) commitPlaneSelection(id)
        else toggleSelect(id)
      }}
    >
      <shapeGeometry args={[shape]} />
      <meshBasicMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
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
