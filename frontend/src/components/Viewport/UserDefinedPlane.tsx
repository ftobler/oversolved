import { useCallback } from 'react'
import type { PlaneTransform } from '@/types/cad'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { planeRotationFromTransform } from '@/components/Geometry3D/utils'
import { useHoverAndDynamicSelection } from '@/components/Geometry3D/useHoverAndDynamicSelection'
import { PlaneLabel, PlaneSurface, type PlaneState } from '@/components/Viewport/PlaneVisual'

/** Encapsulates click routing for plane elements:
 *  1. plane selection mode active  -> commitPlaneSelection
 *  2. pendingPickField set         -> toggleNormalSelection + commitFieldPick
 *  3. otherwise                    -> toggleNormalSelection */
function usePlaneClickDispatch(selId: string): (e: { stopPropagation: () => void }) => void {
  const toggleNormalSelection = useSketchEditorStore(s => s.toggleNormalSelection)
  const commitPlaneSelection = useSketchEditorStore(s => s.commitPlaneSelection)
  const planeSelectionFeatureId = useSketchEditorStore(s => s.planeSelectionFeatureId)
  const pendingPickField = useSketchEditorStore(s => s.pendingPickField)
  const commitFieldPick = useSketchEditorStore(s => s.commitFieldPick)

  return useCallback((e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    if (planeSelectionFeatureId) commitPlaneSelection(selId)
    else {
      toggleNormalSelection(selId)
      if (pendingPickField) commitFieldPick()
    }
  }, [selId, pendingPickField, commitFieldPick, planeSelectionFeatureId, commitPlaneSelection, toggleNormalSelection])
}

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
  const setHoveredPlane = useSketchEditorStore(s => s.setHoveredPlane)
  const selected = useSketchEditorStore(s => s.normalSelection.has(`@${featureId}`))
  const isDragging = drag !== null
  const selId = `@${featureId}`

  const { hovered, onOver, onOut } = useHoverAndDynamicSelection({
    id: selId,
    hoverPayload: useCallback(() => setHoveredPlane(selId), [setHoveredPlane, selId]),
    clearHoverPayload: useCallback(() => setHoveredPlane(null), [setHoveredPlane]),
  })

  const onClick = usePlaneClickDispatch(selId)
  const onPointerOver = useCallback((e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    onOver(e)
  }, [onOver])

  const planeState: PlaneState = hovered ? 'hovered' : selected ? 'selected' : 'default'
  const rot = planeRotationFromTransform(planeTransform)
  const [ox, oy, oz] = planeTransform.origin
  const ph = size / 2

  return (
    <group position={[ox, oy, oz]} rotation={rot}>
      <PlaneSurface
        size={size}
        state={planeState}
        hideMesh={isDragging}
        onPointerOver={onPointerOver}
        onPointerOut={onOut}
        onClick={onClick}
      />
      <PlaneLabel x={-ph} y={ph}>{label}</PlaneLabel>
    </group>
  )
}
