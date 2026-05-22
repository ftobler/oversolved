import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { builtinSelectionId } from '@/components/Geometry3D/utils'
import { PlaneLabel, PlaneSurface, type PlaneState } from '@/components/Viewport/PlaneVisual'
import { usePlaneIdRegistration } from '@/picking'

const PLANE_SIZE = 100
const PH = PLANE_SIZE / 2

interface ReferencePlaneProps {
  rotation: [number, number, number]
  label: string
}

export default function ReferencePlane({ rotation, label }: ReferencePlaneProps) {
  const hoveredSelectionId = useSketchEditorStore(s => s.hoveredSelectionId)
  const drag = useSketchEditorStore(s => s.drag)
  const selId = builtinSelectionId(label)
  const selected = useSketchEditorStore(s => s.normalSelection.has(selId))

  usePlaneIdRegistration({ selectionId: selId, size: PLANE_SIZE, rotation })

  const hovered = hoveredSelectionId === selId
  const planeState: PlaneState = hovered ? 'hovered' : selected ? 'selected' : 'default'
  const isDragging = drag !== null

  return (
    <group rotation={rotation}>
      <PlaneSurface
        size={PLANE_SIZE}
        state={planeState}
        hideMesh={isDragging}
      />
      <PlaneLabel x={-PH} y={PH}>{label}</PlaneLabel>
    </group>
  )
}
