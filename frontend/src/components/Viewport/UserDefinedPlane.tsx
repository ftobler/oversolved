import type { PlaneTransform } from '@/types/cad'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { planeRotationFromTransform } from '@/components/Geometry3D/utils'
import { PlaneLabel, PlaneSurface, type PlaneState } from '@/components/Viewport/PlaneVisual'
import { usePlaneIdRegistration } from '@/picking'

export default function UserDefinedPlane({
  featureId,
  label,
  planeTransform,
  size = 100,
}: {
  featureId: string
  label: string
  planeTransform: PlaneTransform
  size?: number
}) {
  const drag = useSketchEditorStore(s => s.drag)
  const hoveredSelectionId = useSketchEditorStore(s => s.hoveredSelectionId)
  const selected = useSketchEditorStore(s => s.normalSelection.has(`@${featureId}`))
  const isDragging = drag !== null
  const selId = `@${featureId}`

  const hovered = hoveredSelectionId === selId
  const planeState: PlaneState = hovered ? 'hovered' : selected ? 'selected' : 'default'
  const rot = planeRotationFromTransform(planeTransform)
  const [ox, oy, oz] = planeTransform.origin
  const ph = size / 2

  usePlaneIdRegistration({ selectionId: selId, size, rotation: rot, origin: [ox, oy, oz] })

  return (
    <group position={[ox, oy, oz]} rotation={rot}>
      <PlaneSurface
        size={size}
        state={planeState}
        hideMesh={isDragging}
      />
      <PlaneLabel x={-ph} y={ph}>{label}</PlaneLabel>
    </group>
  )
}
