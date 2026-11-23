import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { useScreenScale } from '@/components/Geometry3D/useScreenScale'
import { Dot } from '@/components/Geometry3D/DotMesh'
import { COLOR_HOVER, COLOR_SELECTED, COLOR_CONSTRAINT_HOVER, entityRenderLayer, highlightState } from '@/components/Geometry3D/constants'

// The dot primitive itself lives beside this file so other overlays (snap,
// origin, assembly builtin) share it. Re-exported here: every existing import
// site names VertexDots.
export { Dot }

// Square highlight rendered at z=0.001 so it's always visible above lines.
export function VertexHighlight({ x, y, px, color }: { x: number; y: number; px: number; color: string }) {
  const groupRef = useScreenScale<THREE.Group>(px, { billboard: true })
  const h = 1.4  // half-size of square in local units
  const pts: [number, number, number][] = [[-h, -h, 0], [h, -h, 0], [h, h, 0], [-h, h, 0], [-h, -h, 0]]
  return (
    <group ref={groupRef} position={[x, y, 0]}>
      <Line points={pts} color={color} lineWidth={2} />
    </group>
  )
}

/** Vertex dot with its own independent hover state. Placed as a sibling (not child)
 *  of the edge group so hover does not bubble up and highlight the whole entity.
 *
 *  As of 267.5 the ID buffer dispatcher handles all picking; this component
 *  is visual-only, no R3F event props. */
export function VertexDot({ x, y, px, baseColor, featureId, entityId, vertexKey, isEditing, suppressedVertexIds }: {
  x: number; y: number; px: number; baseColor: string
  featureId?: string; entityId?: string; vertexKey?: string
  isEditing?: boolean
  // Composite ids hidden because a coincident-bonded leader already draws this
  // point. Pick registration suppresses the same ids so render and pick agree.
  suppressedVertexIds?: Set<string>
}) {
  const vertId = featureId && entityId && vertexKey ? `vertex:${featureId}:${entityId}:${vertexKey}` : undefined

  const constraintHovered = useSketchEditorStore(s =>
    entityId && vertexKey ? s.hoveredConstraintEntityIds.has(`${entityId}:${vertexKey}`) : false
  )
  const hoveredVertexId = useSketchEditorStore(s => s.hoveredVertexId)
  const selected = useSketchEditorStore(s => vertId ? s.normalSelection.has(vertId) : false)

  // Hover state is driven by the ID-buffer dispatcher (267.5).
  const hovered = vertId ? hoveredVertexId === vertId : false

  const state = highlightState(selected, hovered)
  const color = state === 'selected' ? COLOR_SELECTED
    : state === 'hovered' ? COLOR_HOVER
    : constraintHovered ? COLOR_CONSTRAINT_HOVER : baseColor
  const layer = entityRenderLayer({ isEditing, selected, hovered })

  // After the hooks (rules-of-hooks): a coincident partner is not drawn -- the
  // cluster leader stands in for it, so the merged point reads as one handle.
  if (vertId && suppressedVertexIds?.has(vertId)) return null

  return (
    <Dot x={x} y={y} px={hovered ? px + 2 : px} color={color} billboard {...layer} />
  )
}

