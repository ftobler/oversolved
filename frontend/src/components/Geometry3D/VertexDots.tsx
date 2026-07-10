import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { useScreenScale } from '@/components/Geometry3D/useScreenScale'
import { COLOR_HOVER, COLOR_SELECTED, COLOR_CONSTRAINT_HOVER, COLOR_PROJECTED, COLOR_INACTIVE, entityRenderLayer } from '@/components/Geometry3D/constants'

/** 10-gon dot with constant pixel radius regardless of zoom.
 *  If billboard=true the dot always faces the camera.
 *  renderOrder and depthTest control z-ordering (use for always-on-top elements). */
export function Dot({ x, y, px, color, billboard = false, renderOrder = 0, depthTest = true }: {
  x: number; y: number; px: number; color: string; billboard?: boolean; renderOrder?: number; depthTest?: boolean
}) {
  const meshRef = useScreenScale<THREE.Mesh>(px, { billboard })
  return (
    <mesh ref={meshRef} position={[x, y, 0]} renderOrder={renderOrder}>
      <circleGeometry args={[1, 10]} />
      <meshBasicMaterial color={color} side={THREE.DoubleSide} depthTest={depthTest} transparent={!depthTest} />
    </mesh>
  )
}

// Square highlight rendered at z=0.001 so it's always visible above lines.
export function VertexHighlight({ x, y, px, color }: { x: number; y: number; px: number; color: string }) {
  const groupRef = useScreenScale<THREE.Group>(px, { billboard: true })
  const h = 1.4 // half-size of square in local units
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
 *  is visual-only — no R3F event props. */
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

  const color = hovered ? COLOR_HOVER : selected ? COLOR_SELECTED : constraintHovered ? COLOR_CONSTRAINT_HOVER : baseColor
  const { depthTest, renderOrder } = entityRenderLayer({ isEditing, selected, hovered })

  // After the hooks (rules-of-hooks): a coincident partner is not drawn -- the
  // cluster leader stands in for it, so the merged point reads as one handle.
  if (vertId && suppressedVertexIds?.has(vertId)) return null

  return (
    <Dot x={x} y={y} px={hovered ? px + 2 : px} color={color} billboard renderOrder={renderOrder} depthTest={depthTest} />
  )
}

/** Dot marker at constant pixel size for a projected reference point. Drawn like
 *  a sketch point (same size and grow-on-hover as VertexDot) so a projection
 *  reads as a point of the sketch, only in the projected colour.
 *
 *  As of 267.5 the ID buffer dispatcher handles all picking; this component
 *  is visual-only — no R3F event props. */
export function ProjectedOriginPoint({ x, y, featureId, entityId, isEditing = false }: { x: number; y: number; featureId: string; entityId: string; isEditing?: boolean }) {
  const entId = `entity:${featureId}:${entityId}`
  const selected = useSketchEditorStore(s => s.normalSelection.has(entId))
  const constraintHovered = useSketchEditorStore(s => s.hoveredConstraintEntityIds.has(entityId))
  const hoveredSelectionId = useSketchEditorStore(s => s.hoveredSelectionId)

  // Hover state is driven by the ID-buffer dispatcher.
  const hovered = hoveredSelectionId === entId

  const color = hovered ? COLOR_HOVER : selected ? COLOR_SELECTED : constraintHovered ? COLOR_CONSTRAINT_HOVER : (isEditing ? COLOR_PROJECTED : COLOR_INACTIVE)
  const { depthTest, renderOrder } = entityRenderLayer({ isEditing, selected, hovered })
  return (
    <Dot x={x} y={y} px={hovered ? 7 : 5} color={color} billboard renderOrder={renderOrder} depthTest={depthTest} />
  )
}
