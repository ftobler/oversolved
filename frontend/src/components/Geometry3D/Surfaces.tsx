import { useMemo } from 'react'
import * as THREE from 'three'
import type { ThreeEvent } from '@react-three/fiber'
import type { Topology, TopologySurface } from '@/types/cad'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { ARC_SEGMENTS, COLOR_SELECTED, COLOR_INACTIVE, COLOR_HOVER } from '@/components/Geometry3D/constants'
import { tessellateBoundary } from '@/kernel/topologyBoundary'

type SurfaceShape = { shape: THREE.Shape; pts: [number, number][]; query: string }

// eslint-disable-next-line react-refresh/only-export-components
export function buildSurfaceShapes(topology: Topology): SurfaceShape[] {
  return topology.surfaces.flatMap((surface: TopologySurface) => {
    const pts = tessellateBoundary(surface.boundary, ARC_SEGMENTS)
    if (pts.length < 3) return []
    const shape = new THREE.Shape()
    shape.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1])
    shape.closePath()
    // Inner loops become THREE.Path holes so a donut renders with its hole.
    for (const hole of surface.holes ?? []) {
      const hpts = tessellateBoundary(hole, ARC_SEGMENTS)
      if (hpts.length < 3) continue
      const path = new THREE.Path()
      path.moveTo(hpts[0][0], hpts[0][1])
      for (let i = 1; i < hpts.length; i++) path.lineTo(hpts[i][0], hpts[i][1])
      path.closePath()
      shape.holes.push(path)
    }
    return [{ shape, pts, query: surface.query }]
  })
}

// 'inactive' = another sketch is being edited (this one is dimmed, no events)
// 'editing'  = this sketch is being edited (ID buffer owns entity/vertex events)
// 'view'     = no sketch is being edited (R3F mesh events handle selection)
export type TopologyMode = 'view' | 'editing' | 'inactive'

interface SurfaceMeshProps {
  shape: THREE.Shape
  query: string
  mode: TopologyMode
}

// Fill color/opacity for a sketch area, given selection/hover state. Selection
// wins over hover; hover is suppressed while another sketch is being edited
// ('inactive'). Selection still shows when inactive so a picked area stays lit.
// eslint-disable-next-line react-refresh/only-export-components
export function surfaceFillStyle(
  mode: TopologyMode, isSelected: boolean, isHovered: boolean,
): { color: string; opacity: number } {
  if (isSelected) return { color: COLOR_SELECTED, opacity: 0.30 }
  if (isHovered && mode !== 'inactive') return { color: COLOR_HOVER, opacity: 0.20 }
  if (mode === 'inactive') return { color: COLOR_INACTIVE, opacity: 0.10 }
  return { color: 'white', opacity: 0.10 }
}

export function SurfaceMesh({ shape, query, mode }: SurfaceMeshProps) {
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const hoveredSelectionId = useSketchEditorStore(s => s.hoveredSelectionId)

  // Selection/hover keys are the raw ancestral query, identical to what the
  // collision-id buffer stores (no wrapping) -- same convention as B-rep faces.
  const isSelected = normalSelection.has(query)
  const isHovered = hoveredSelectionId === query
  const { color, opacity } = surfaceFillStyle(mode, isSelected, isHovered)

  // Decoration only -- never a selection path. The collision-id render pass is
  // the single selection source: a surface click routes through
  // useIdBufferPointerDispatch, which stores the raw query verbatim. A second
  // toggle here produced a duplicate, wrapped (`face:<fid>:<query>`) entry and
  // raced the pick-chip consume, breaking profile picking. stopPropagation
  // still guards against a mounted DrawPlane clearing the pick; onPointerMissed
  // already ignores clicks the id-buffer consumed.
  const handleClick = mode === 'inactive' ? undefined : (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
  }

  return (
    <mesh
      onClick={handleClick}
    >
      <shapeGeometry args={[shape]} />
      <meshBasicMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  )
}

interface TopologySurfacesProps {
  topology: Topology
  isEditing: boolean
  activeFeatureId?: string
}

export function TopologySurfaces({ topology, isEditing, activeFeatureId }: TopologySurfacesProps) {
  const surfaces = useMemo(() => buildSurfaceShapes(topology), [topology])
  const mode: TopologyMode = activeFeatureId !== undefined ? (isEditing ? 'editing' : 'inactive') : 'view'
  return (
    <>
      {surfaces.map((s, si) => (
        <SurfaceMesh
          key={si}
          shape={s.shape}
          query={s.query}
          mode={mode}
        />
      ))}
    </>
  )
}
