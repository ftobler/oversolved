import { useState, useCallback, useEffect } from 'react'
import { useSketchEditorStore, getSketchCallback } from '@/stores/sketchEditorStore'
import { COLOR_CONSTRAINT } from '@/components/sketch/sketch_helpers'
import { COLOR_SELECTED } from '@/components/Geometry3D/constants'
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
  // Single-click selects only. The edit dialog is gated behind double-click so a
  // selected dim can be deleted via the Delete key without the modal eating focus.
  const onClick = useCallback((ev: { stopPropagation: () => void }) => {
    if (consumeClick()) return
    if (!interaction) return
    ev.stopPropagation()
    const st = useSketchEditorStore.getState()
    st.clearNormalSelection()
    st.addToNormalSelection(`constraint:${interaction.featureId}:${cid}`)
  }, [interaction, cid, consumeClick])
  const onDoubleClick = useCallback((ev: { stopPropagation: () => void; clientX: number; clientY: number }) => {
    if (consumeClick()) return
    if (!interaction) return
    ev.stopPropagation()
    useSketchEditorStore.getState().openDialog({
      position: [ev.clientX, ev.clientY],
      label: interaction.promptLabel,
      defaultValue: String(value),
      validate: (input) => {
        const val = parseFloat(input)
        if (isNaN(val)) return 'Enter a number'
        if (validatePositive && val <= 0) return 'Must be greater than 0'
        return null
      },
      onConfirm: (input) => {
        getSketchCallback('onMutation')?.({ type: 'set_constraint_value', featureId: interaction.featureId, constraintId: cid, value: parseFloat(input) })
      },
    })
  }, [interaction, cid, value, validatePositive, consumeClick])
  // Called at the start of each pointer-down so a fresh drag begins with the flag clear.
  const resetDragMoved = reset

  // Hide the hit mesh while this constraint is being dragged. Historically
  // this guarded against the (now-retired) DragPlane mesh raycast being
  // occluded by the label's hit circle (#266 migrated drag to a math-only
  // THREE.Plane, so occlusion is no longer possible). Kept because it
  // doubles as a UX nicety -- the hit halo stays visually quiet mid-drag.
  const isDragged = drag?.type === 'dim_label' && drag.constraintId === cid

  const selKey = interaction ? `constraint:${interaction.featureId}:${cid}` : null
  const selected = useSketchEditorStore(s => selKey ? s.normalSelection.has(selKey) : false)

  const color = selected ? COLOR_SELECTED : hovered ? '#ffffff' : COLOR_CONSTRAINT
  return { hovered, selected, color, onOver, onOut, onClick, onDoubleClick, resetDragMoved, isDragged }
}

// Returns the active dragged label position for this constraint (if being dragged), else null.
export function useActiveLabelDrag(cid: string): [number, number] | null {
  const drag = useSketchEditorStore(s => s.drag)
  if (drag?.type === 'dim_label' && drag.constraintId === cid) {
    return drag.currentWorld
  }
  return null
}
