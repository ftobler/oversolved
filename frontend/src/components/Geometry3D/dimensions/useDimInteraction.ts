import { useState, useCallback, useEffect } from 'react'
import { useSketchEditorStore, getSketchCallback } from '@/stores/sketchEditorStore'
import { COLOR_CONSTRAINT } from '@/components/sketch_helpers'
import { useClickAfterDragSuppression } from '../useClickAfterDragSuppression'

/** Optional interactive context for dimension components.
 *  When provided, hover highlights entities, click opens an edit prompt,
 *  and pointer-down initiates a drag to reposition the label. */
export interface DimInteraction {
  featureId: string
  entityId: string
  constraintId: string
  promptLabel: string
}

export function useDimInteraction(cid: string, value: number, interaction: DimInteraction | undefined, validatePositive = true) {
  const setHoveredConstraintEntities = useSketchEditorStore(s => s.setHoveredConstraintEntities)
  const drag = useSketchEditorStore(s => s.drag)
  const [hovered, setHovered] = useState(false)

  // Suppress the click that the browser fires on the label mesh after a drag.
  // When the pointer moves during a dim_label drag we set this flag; the next
  // click clears it and returns early so the edit prompt is not shown.
  const { markMoved, consumeClick, reset } = useClickAfterDragSuppression()
  useEffect(() => {
    if (drag?.type === 'dim_label' && drag.constraintId === cid) {
      const moved = drag.currentWorld[0] !== drag.startWorld[0]
        || drag.currentWorld[1] !== drag.startWorld[1]
      if (moved) markMoved()
    }
  }, [drag, cid, markMoved])

  const onOver = useCallback((ev: { stopPropagation: () => void }) => {
    ev.stopPropagation()
    setHovered(true)
    if (interaction) setHoveredConstraintEntities(new Set([interaction.entityId]))
  }, [interaction, setHoveredConstraintEntities])
  const onOut = useCallback(() => {
    setHovered(false)
    if (interaction) setHoveredConstraintEntities(new Set())
  }, [interaction, setHoveredConstraintEntities])
  const onClick = useCallback((ev: { stopPropagation: () => void; clientX: number; clientY: number }) => {
    if (consumeClick()) return
    if (!interaction) return
    ev.stopPropagation()
    useSketchEditorStore.getState().openDialog({
      position: [ev.clientX, ev.clientY],
      label: interaction.promptLabel,
      defaultValue: String(value),
      onConfirm: (input) => {
        const val = parseFloat(input)
        if (isNaN(val) || (validatePositive && val <= 0)) return
        getSketchCallback('onMutation')?.({ type: 'set_constraint_value', featureId: interaction.featureId, constraintId: cid, value: val })
      },
    })
  }, [interaction, cid, value, validatePositive, consumeClick])
  // Called at the start of each pointer-down so a fresh drag begins with the flag clear.
  const resetDragMoved = reset

  // REGRESSION PROTECTION: Hide hit mesh during dim_label drag
  // BUG: When dragging a dimension label, the label's own circle hit mesh at z=0.001
  //      blocks raycasts to the DragPlane at z=-0.001, causing choppy/stalled dragging.
  // FIX: Check if this constraint is currently being dragged. If so, skip rendering
  //      the hit mesh so raycasts reach the DragPlane smoothly.
  // See: EntityLines.tsx and VertexDots.tsx for the same fix on entities/vertices.
  const isDragged = drag?.type === 'dim_label' && drag.constraintId === cid

  const color = hovered ? '#ffffff' : COLOR_CONSTRAINT
  return { hovered, color, onOver, onOut, onClick, resetDragMoved, isDragged }
}

// Returns the active dragged label position for this constraint (if being dragged), else null.
export function useActiveLabelDrag(cid: string): [number, number] | null {
  const drag = useSketchEditorStore(s => s.drag)
  if (drag?.type === 'dim_label' && drag.constraintId === cid) {
    return drag.currentWorld
  }
  return null
}
