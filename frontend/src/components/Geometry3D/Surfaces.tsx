import { useMemo } from 'react'
import * as THREE from 'three'
import type { ThreeEvent } from '@react-three/fiber'
import type { Topology } from '@/types/cad'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { COLOR_SELECTED, COLOR_INACTIVE, COLOR_HOVER, COLOR_ERROR, highlightState } from '@/components/Geometry3D/constants'
import { buildSurfaceShapes } from '@/utils/geometry/surfaceShapes'

// 'inactive' = another sketch is being edited (this one is dimmed, no events)
// 'editing'  = this sketch is being edited (ID buffer owns entity/vertex events)
// 'view'     = no sketch is being edited (R3F mesh events handle selection)
export type TopologyMode = 'view' | 'editing' | 'inactive'

interface SurfaceMeshProps {
  shape: THREE.Shape
  query: string
  mode: TopologyMode
  buildable?: boolean
}

// Fill color/opacity for a sketch area, given selection/hover state. Selection
// wins over hover; hover is suppressed while another sketch is being edited
// ('inactive'). Selection still shows when inactive so a picked area stays lit.
//
// An area the kernel provably cannot build from (buildable === false, stamped by
// topologyDecorate) takes COLOR_ERROR -- the hue this viewport already uses for
// "this will not solve" -- and sits ABOVE the normal white fill in opacity. It
// has to: the point of the mark is to reach the eye before the user picks the
// area as a profile, and a broken area drawn fainter than a working one inverts
// exactly the affordance it exists to provide. It stays under hover (0.20) so
// pointing at it still reads as a state change, and it ranks below selection,
// hover and the inactive dimming, which answer the more urgent "what am I
// acting on". The area stays pickable either way.
// eslint-disable-next-line react-refresh/only-export-components -- module exports a pure style helper alongside components
export function surfaceFillStyle(
  mode: TopologyMode, isSelected: boolean, isHovered: boolean, buildable = true,
): { color: string; opacity: number } {
  // Hover is suppressed while another sketch is being edited ('inactive'), so
  // the state passed to the shared rule is the one the user can act on.
  const state = highlightState(isSelected, isHovered && mode !== 'inactive')
  if (state === 'selected') return { color: COLOR_SELECTED, opacity: 0.30 }
  if (state === 'hovered') return { color: COLOR_HOVER, opacity: 0.20 }
  if (mode === 'inactive') return { color: COLOR_INACTIVE, opacity: 0.10 }
  if (!buildable) return { color: COLOR_ERROR, opacity: 0.18 }
  return { color: 'white', opacity: 0.10 }
}

export function SurfaceMesh({ shape, query, mode, buildable = true }: SurfaceMeshProps) {
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const hoveredSelectionId = useSketchEditorStore(s => s.hoveredSelectionId)

  // Selection/hover keys are the raw ancestral query, identical to what the
  // collision-id buffer stores (no wrapping) -- same convention as B-rep faces.
  const isSelected = normalSelection.has(query)
  const isHovered = hoveredSelectionId === query
  const { color, opacity } = surfaceFillStyle(mode, isSelected, isHovered, buildable)

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
      {surfaces.map(s => (
        <SurfaceMesh
          key={s.query}
          shape={s.shape}
          query={s.query}
          mode={mode}
          buildable={s.buildable}
        />
      ))}
    </>
  )
}
