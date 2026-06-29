import { useState, useCallback, useEffect, useRef } from 'react'
import { useSketchEditorStore, getSketchCallback } from '@/stores/sketchEditorStore'
import { evalExpr } from '@/kernel/evalExpr'
import { COLOR_CONSTRAINT } from '@/utils/geometry/sketchHelpers'
import { COLOR_SELECTED, LABEL_Z_OFFSET } from '@/components/Geometry3D/constants'
import { useDimensionLabelIdRegistration } from '@/picking/useDimensionLabelIdRegistration'
import { useDimDispatchRegistration } from './useDimDispatchRegistration'
import type { PlaneTransform } from '@/types/cad'

function useClickAfterDragSuppression() {
  const moved = useRef(false)
  const markMoved = useCallback(() => { moved.current = true }, [])
  const consumeClick = useCallback((): boolean => {
    if (moved.current) { moved.current = false; return true }
    return false
  }, [])
  const reset = useCallback(() => { moved.current = false }, [])
  return { markMoved, consumeClick, reset }
}

/** Optional interactive context for dimension components.
 *  When provided, hover highlights entities, click opens an edit prompt,
 *  and pointer-down initiates a drag to reposition the label. */
export interface DimInteraction {
  featureId: string
  entityId: string
  constraintId: string
  promptLabel: string
}

export function useDimInteraction(
  cid: string,
  value: number,
  interaction: DimInteraction | undefined,
  validatePositive = true,
  // When provided (directional dims only), the edit dialog shows a "Flip side"
  // button that runs this handler to swap the dimension's orientation sign.
  onFlip?: () => void,
  // Maps the value the user edits (what the label shows) back to the value
  // stored on the constraint. Identity by default; angle dims placed in a
  // supplement quadrant pass `v => 180 - v` so editing 180-theta stores theta.
  encodeValue?: (displayed: number) => number,
) {
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
        const val = evalExpr(input)
        if (isNaN(val)) return 'Enter a number or expression'
        if (validatePositive && val <= 0) return 'Must be greater than 0'
        return null
      },
      onConfirm: (input) => {
        const edited = evalExpr(input)
        const stored = encodeValue ? encodeValue(edited) : edited
        getSketchCallback('onMutation')?.({ type: 'set_constraint_value', featureId: interaction.featureId, constraintId: cid, value: stored })
      },
      ...(onFlip && { extraAction: { label: 'Flip side', onClick: onFlip } }),
    })
  }, [interaction, cid, value, validatePositive, consumeClick, onFlip, encodeValue])
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

/**
 * Pointer-down handler that begins a dim_label drag. Identical wiring across all
 * dimension components; only the anchor (entity-relative origin) and the label
 * start position differ. Scalars are taken individually so the memoization deps
 * match the per-component originals.
 */
export function useDimLabelPointerDown(
  cid: string,
  interaction: DimInteraction | undefined,
  resetDragMoved: () => void,
  anchorX: number, anchorY: number,
  labelX: number, labelY: number,
) {
  const setIsPointerDown = useSketchEditorStore(s => s.setIsPointerDown)
  const setDragStartClient = useSketchEditorStore(s => s.setDragStartClient)
  const setDragPending = useSketchEditorStore(s => s.setDragPending)
  return useCallback((e: { stopPropagation: () => void; clientX: number; clientY: number }) => {
    if (!interaction) return
    e.stopPropagation()
    resetDragMoved()
    setIsPointerDown(true)
    setDragStartClient([e.clientX, e.clientY])
    setDragPending({
      type: 'dim_label',
      constraintId: cid,
      featureId: interaction.featureId,
      anchorWorld: [anchorX, anchorY],
      startWorld: [labelX, labelY],
    })
  }, [interaction, cid, anchorX, anchorY, labelX, labelY, resetDragMoved, setIsPointerDown, setDragStartClient, setDragPending])
}

/**
 * Registers a dimension label's pickable id and its pointer-event dispatch.
 * This pair of calls is identical across every dimension component; only the
 * label position and the dispatch handlers vary. The dispatched `onClick` is
 * always a no-op (single-click selection is handled on the label mesh itself).
 */
export function useDimLabelRegistration(args: {
  cid: string
  interaction: DimInteraction | undefined
  isDragged: boolean
  labelX: number
  labelY: number
  planeTransform?: PlaneTransform
  onOver: (e: { stopPropagation: () => void }) => void
  onOut: () => void
  onDoubleClick: (e: { stopPropagation: () => void; clientX: number; clientY: number }) => void
  onPointerDown: (e: { stopPropagation: () => void; clientX: number; clientY: number }) => void
}): void {
  useDimensionLabelIdRegistration({
    constraintId: args.cid,
    position: [args.labelX, args.labelY, LABEL_Z_OFFSET],
    enabled: !!args.interaction && !args.isDragged,
    planeTransform: args.planeTransform,
  })
  useDimDispatchRegistration(args.cid, {
    onOver: args.onOver,
    onOut: args.onOut,
    onClick: () => {},
    onDoubleClick: args.onDoubleClick,
    onPointerDown: args.onPointerDown,
  })
}

// Returns the active dragged label position for this constraint (if being dragged), else null.
export function useActiveLabelDrag(cid: string): [number, number] | null {
  const drag = useSketchEditorStore(s => s.drag)
  if (drag?.type === 'dim_label' && drag.constraintId === cid) {
    return drag.currentWorld
  }
  return null
}
