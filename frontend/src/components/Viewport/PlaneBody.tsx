import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { PlaneLabel, PlaneSurface, type PlaneState } from '@/components/Viewport/PlaneVisual'
import { usePlaneIdRegistration } from '@/picking'

/**
 * Shared body for plane visuals (reference planes and user-defined planes):
 * registers the pick quad, derives the hover/selected visual state, and renders
 * the surface + corner label. Callers supply the selection id and placement.
 */
export default function PlaneBody({
  selId,
  size,
  rotation,
  origin,
  label,
}: {
  selId: string
  size: number
  rotation: [number, number, number]
  origin?: [number, number, number]
  label: string
}) {
  const hoveredSelectionId = useSketchEditorStore(s => s.hoveredSelectionId)
  // Select only the boolean the plane cares about: the DragState object is
  // replaced on every pointermove tick, so subscribing to `s.drag` would
  // re-render every plane on every tick.
  const isDragging = useSketchEditorStore(s => s.drag !== null)
  const selected = useSketchEditorStore(s => s.normalSelection.has(selId))

  usePlaneIdRegistration({ selectionId: selId, size, rotation, origin })

  const hovered = hoveredSelectionId === selId
  const planeState: PlaneState = hovered ? 'hovered' : selected ? 'selected' : 'default'
  const ph = size / 2

  return (
    <group position={origin ?? [0, 0, 0]} rotation={rotation}>
      <PlaneSurface size={size} state={planeState} hideMesh={isDragging} />
      <PlaneLabel x={-ph} y={ph}>{label}</PlaneLabel>
    </group>
  )
}
