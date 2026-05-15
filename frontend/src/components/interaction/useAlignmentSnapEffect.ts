import { useEffect } from 'react'
import type { Sketch } from '@/types/cad'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { detectAlignmentSnap, ALIGNMENT_TOLERANCE_DEG } from '@/registry'
import { useDynamicSelectionPositions } from '@/components/interaction/snapHooks'

export interface DrawAlignmentResult {
  kind: 'kinda_horizontal' | 'kinda_vertical'
  point: [number, number]
  vertexId: 'draw:last'
}

export function detectDrawAlignment(
  currentPosition: [number, number],
  drawLastPoint: [number, number],
): DrawAlignmentResult | null {
  const dx = currentPosition[0] - drawLastPoint[0]
  const dy = currentPosition[1] - drawLastPoint[1]
  const dist = Math.hypot(dx, dy)
  if (dist < 0.001) return null

  const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI)
  const normalizedAngle = ((angleDeg % 180) + 180) % 180

  if (normalizedAngle < ALIGNMENT_TOLERANCE_DEG || normalizedAngle > 180 - ALIGNMENT_TOLERANCE_DEG) {
    return { kind: 'kinda_horizontal', point: drawLastPoint, vertexId: 'draw:last' }
  }
  const verticalAngle = Math.abs(normalizedAngle - 90)
  if (verticalAngle < ALIGNMENT_TOLERANCE_DEG || verticalAngle > 180 - ALIGNMENT_TOLERANCE_DEG) {
    return { kind: 'kinda_vertical', point: drawLastPoint, vertexId: 'draw:last' }
  }
  return null
}

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
 *
 * Implements the alignment snap feature from feature_entity_snap.md:
 * - kinda_horizontal/kinda_vertical snapping for constraint inference
 * - Uses dynamicSelection as reference points for alignment detection
 * - Visual feedback via dashed lines when cursor is aligned
 * - Applies horizontal/vertical constraints on tool completion
 *
 * For the draw tool, alignment detection uses the last draw point as the
 * reference (via the drawLastPoint parameter) since dynamicSelection is
 * typically empty during drawing.
 */
export function useAlignmentSnapEffect(
  sketch: Sketch | undefined,
  currentPosition: [number, number] | null,
  drawLastPoint?: [number, number] | null,
) {
  const dynamicSelection = useSketchEditorStore(s => s.dynamicSelection)
  const setAlignmentSnap = useSketchEditorStore(s => s.setAlignmentSnap)
  const dynamicSelectionPositions = useDynamicSelectionPositions(sketch, dynamicSelection)

  useEffect(() => {
    if (!currentPosition) {
      setAlignmentSnap(null, null, null)
      return
    }

    if (dynamicSelection.size === 0) {
      if (!drawLastPoint) {
        setAlignmentSnap(null, null, null)
        return
      }
      const alignment = detectDrawAlignment(currentPosition, drawLastPoint)
      if (alignment) {
        setAlignmentSnap(alignment.point, alignment.kind, alignment.vertexId)
      } else {
        setAlignmentSnap(null, null, null)
      }
      return
    }

    const alignment = detectAlignmentSnap(dynamicSelection, currentPosition, dynamicSelectionPositions)
    if (alignment) setAlignmentSnap(alignment.point, alignment.kind, alignment.vertexId)
    else setAlignmentSnap(null, null, null)
  }, [currentPosition, dynamicSelection, dynamicSelectionPositions, setAlignmentSnap, drawLastPoint])
}
