import { useState, useCallback, useRef } from 'react'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'

/**
 * Layer 3B — Selection Subsystem: hover state and dynamic selection.
 *
 * Manages the two fast-path concerns that must be shared between all interactive
 * elements (entities, vertices):
 *
 *   1. Local `hovered` state for immediate render-color feedback
 *   2. Dynamic selection accumulation while the pointer is held
 *
 * Tool-layer concerns (drag initiation, dimension clicks, field picking) are
 * intentionally excluded. Callers own their onPointerDown and onClick.
 *
 * Usage pattern:
 *   const { hovered, onOver, onOut, markAsClicked } = useHoverAndDynamicSelection(...)
 *   // In component's onPointerDown: call markAsClicked() before setDrag()
 *   // to prevent the clicked element from accumulating into dynamicSelection.
 */
export function useHoverAndDynamicSelection({
  id,
  hoverPayload,
  clearHoverPayload,
}: {
  /** Full composite element ID (e.g. "entity:F:E" or "vertex:F:E:key"). */
  id: string
  /** Called on pointerover — write element hover state to the store. */
  hoverPayload: () => void
  /** Called on pointerout — clear element hover state in the store. */
  clearHoverPayload: () => void
}): {
  hovered: boolean
  onOver: (e: { stopPropagation: () => void }) => void
  onOut: () => void
  /**
   * Call this inside the component's own onPointerDown, before initiating a
   * drag, to exclude this element from dynamic selection accumulation.
   */
  markAsClicked: () => void
} {
  const [hovered, setHovered] = useState(false)

  const isRotating = useSketchEditorStore(s => s.isRotating)
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const setInternalHoverSelection = useSketchEditorStore(s => s.setInternalHoverSelection)

  const clickedRef = useRef<string | null>(null)

  const isDrawingTool = (activeTool ?? 'drag') !== 'select' && (activeTool ?? 'drag') !== 'dimension'
  const isInNormalSelection = normalSelection.has(id)

  const onOver = useCallback((e: { stopPropagation: () => void }) => {
    if (isRotating) return
    if (!isDrawingTool) e.stopPropagation()
    if (!isInNormalSelection) setHovered(true)
    setInternalHoverSelection(id)
    hoverPayload()
  }, [isRotating, isDrawingTool, isInNormalSelection, setInternalHoverSelection, hoverPayload, id])

  const onOut = useCallback(() => {
    if (isRotating) return
    setInternalHoverSelection(null)
    if (clickedRef.current === id) clickedRef.current = null
    setHovered(false)
    clearHoverPayload()
  }, [isRotating, id, setInternalHoverSelection, clearHoverPayload])

  const markAsClicked = useCallback(() => {
    clickedRef.current = id
  }, [id])

  return { hovered, onOver, onOut, markAsClicked }
}
