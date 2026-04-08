import { useEffect } from 'react'
import type { Sketch } from '../../types/cad'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { detectAlignmentSnap } from '../../registry'
import { useDynamicSelectionPositions } from './snapHooks'

/**
 * Layer 3B — Selection Subsystem: reactive alignment snap detection.
 *
 * When dynamicSelection is non-empty and the cursor is within
 * ALIGNMENT_TOLERANCE_DEG of horizontal or vertical alignment with a
 * dynamically-selected point, writes the alignment snap to the store.
 * Both the preview indicator (DragAlignmentIndicator) and constraint
 * insertion read from there.
 *
 * This is the *reactive* (useEffect-based) variant. It is correct for tools
 * that expose their current position as React state (e.g. the draw tool
 * stores the cursor as drawHover in the store).
 *
 * The drag tool uses an *imperative* equivalent inside onPointerMove because
 * it must compute the alignment-snapped position synchronously in order to
 * set currentWorld in the same pointer-move event — a one-render delay would
 * produce visible stutter in the drag preview.
 */
export function useAlignmentSnapEffect(
  sketch: Sketch | undefined,
  currentPosition: [number, number] | null,
) {
  const dynamicSelection = useSketchEditorStore(s => s.dynamicSelection)
  const setAlignmentSnap = useSketchEditorStore(s => s.setAlignmentSnap)
  const dynamicSelectionPositions = useDynamicSelectionPositions(sketch, dynamicSelection)

  useEffect(() => {
    if (!currentPosition || dynamicSelection.size === 0) {
      setAlignmentSnap(null, null, null)
      return
    }
    const alignment = detectAlignmentSnap(dynamicSelection, currentPosition, dynamicSelectionPositions)
    if (alignment) setAlignmentSnap(alignment.point, alignment.kind, alignment.vertexId)
    else setAlignmentSnap(null, null, null)
  }, [currentPosition, dynamicSelection, dynamicSelectionPositions, setAlignmentSnap])
}
