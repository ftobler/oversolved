import { useState } from 'react'
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
  // HOVER PATTERN: Local state for visual feedback (fast), store for logic/debug.
  // DO NOT use local hovered state alone - must also call setHoveredPlane().
  const [hovered, setHovered] = useState(false)
  const toggleNormalSelection = useSketchEditorStore(s => s.toggleNormalSelection)
  const commitPlaneSelection = useSketchEditorStore(s => s.commitPlaneSelection)
  const planeSelectionFeatureId = useSketchEditorStore(s => s.planeSelectionFeatureId)
  const pendingPickField = useSketchEditorStore(s => s.pendingPickField)
  const commitFieldPick = useSketchEditorStore(s => s.commitFieldPick)
  const drag = useSketchEditorStore(s => s.drag)
  const setHoveredPlane = useSketchEditorStore(s => s.setHoveredPlane)
  const isRotating = useSketchEditorStore(s => s.isRotating)
  const selId = builtinSelectionId(label)
  const selected = useSketchEditorStore(s => s.normalSelection.has(selId))

  usePlaneIdRegistration({ selectionId: selId, size: PLANE_SIZE, rotation })

  const planeState: PlaneState = hovered ? 'hovered' : selected ? 'selected' : 'default'
  // REGRESSION PROTECTION: Hide collision mesh during any drag
  // BUG: Reference planes (XY, XZ, YZ) collision could block DragPlane raycasts,
  //      causing dragging to fail when cursor moved over a reference plane.
  // FIX: Hide the plane's collision mesh whenever ANY drag is in progress
  //      (not just dragging in this sketch). This is simpler than checking
  //      featureId since planes are global to the viewport.
  // NOTE: Simple check: isDragging = drag !== null (checks all drag types)
  // See: src/components/__tests__/dragging.test.ts (REGRESSION 3)
  const isDragging = drag !== null

  return (
    <group rotation={rotation}>
      <PlaneSurface
        size={PLANE_SIZE}
        state={planeState}
        hideMesh={isDragging}
        onPointerOver={e => { if (isRotating) return; e.stopPropagation(); setHovered(true); setHoveredPlane(selId) }}
        onPointerOut={() => { if (isRotating) return; setHovered(false); setHoveredPlane(null) }}
        onClick={e => {
          e.stopPropagation()
          if (planeSelectionFeatureId) commitPlaneSelection(selId)
          else { toggleNormalSelection(selId); if (pendingPickField) commitFieldPick() }
        }}
      />
      <PlaneLabel x={-PH} y={PH}>{label}</PlaneLabel>
    </group>
  )
}
