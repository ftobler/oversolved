import { useEffect } from 'react'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'

/**
 * Layer 3B — Selection Subsystem: pointer-up lifecycle cleanup.
 *
 * Clears isPointerDown and dynamicSelection when any pointer button is
 * released. Must be mounted at a level where its window listener is active
 * for the full session (Viewport or higher).
 *
 * The window-level listener is necessary because R3F's onPointerUp only fires
 * when the pointer is released over the canvas. If the user drags out of the
 * viewport and releases, the canvas event never fires, leaving isPointerDown
 * stuck at true and causing every subsequent hover to trigger dynamic selection.
 *
 * DragPlane has its own window pointerup handler to cancel mid-drag. This hook
 * handles the non-drag case: any pointer-up should reset selection state.
 *
 * Implements the pointer-up behavior from feature_dynamic_select.md:
 * - On pointerup: Clear dynamic selection and set isPointerDown = false
 * - Ensures dynamic selection is properly cleared even when pointer leaves canvas
 * - Prevents accumulation of stale dynamic selection state
 */
export function useSelectionPointerUpCleanup() {
  useEffect(() => {
    const cleanup = () => {
      const { isPointerDown, clearDynamicSelection, setIsPointerDown } = useSketchEditorStore.getState()
      if (isPointerDown) {
        setIsPointerDown(false)
        clearDynamicSelection()
      }
    }
    window.addEventListener('pointerup', cleanup)
    return () => window.removeEventListener('pointerup', cleanup)
  }, [])
}
