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
  const isPointerDown = useSketchEditorStore(s => s.isPointerDown)
  const selected = useSketchEditorStore(s => s.selection.has(id))
  const toggleDynamicSelection = useSketchEditorStore(s => s.toggleDynamicSelection)

  const lastHoveredRef = useRef<string | null>(null)
  const clickedRef = useRef<string | null>(null)

  const isDrawingTool = activeTool !== 'select' && activeTool !== 'dimension'

  const onOver = useCallback((e: { stopPropagation: () => void }) => {
    if (isRotating) return
    if (!isDrawingTool) e.stopPropagation()
    if (!selected) setHovered(true)
    hoverPayload()

    // Accumulate into dynamicSelection while pointer is held, excluding self and
    // already-selected elements. lastHoveredRef prevents double-adding on re-entry.
    if (isPointerDown && !selected && lastHoveredRef.current !== id && clickedRef.current !== id) {
      lastHoveredRef.current = id
      toggleDynamicSelection(id)
    }
  }, [isRotating, isDrawingTool, selected, hoverPayload, isPointerDown, id, toggleDynamicSelection])

  const onOut = useCallback(() => {
    if (isRotating) return
    lastHoveredRef.current = null
    if (clickedRef.current === id) clickedRef.current = null
    setHovered(false)
    clearHoverPayload()
  }, [isRotating, id, clearHoverPayload])

  const markAsClicked = useCallback(() => {
    clickedRef.current = id
  }, [id])

  return { hovered, onOver, onOut, markAsClicked }
}
