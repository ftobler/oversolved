import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { builtinSelectionId } from '@/components/Geometry3D/utils'
import { COLOR_HOVER, COLOR_SELECTED, COLOR_INACTIVE, RENDER_ORDER_HIGHLIGHT, highlightState } from '@/components/Geometry3D/constants'
import { Dot } from '@/components/Geometry3D/VertexDots'
import { useOriginMarkerIdRegistration } from '@/picking'

export default function OriginMarker() {
  const selId = builtinSelectionId('Origin')
  const selected = useSketchEditorStore(s => s.normalSelection.has(selId))
  const hoveredSelectionId = useSketchEditorStore(s => s.hoveredSelectionId)

  const hovered = hoveredSelectionId === selId

  useOriginMarkerIdRegistration({ selectionId: selId })

  const state = highlightState(selected, hovered)
  const color = state === 'selected' ? COLOR_SELECTED
    : state === 'hovered' ? COLOR_HOVER
    : COLOR_INACTIVE

  return (
    <group>
      <Dot x={0} y={0} px={hovered ? 6 : 4} color={color} billboard renderOrder={RENDER_ORDER_HIGHLIGHT} depthTest={false} />
    </group>
  )
}
