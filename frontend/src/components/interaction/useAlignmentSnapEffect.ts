import { useEffect } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { ALIGNMENT_TOLERANCE_DEG } from '@/registry'

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
 * Reactive alignment snap detection for the draw tool.
 * Uses the last draw point as the reference point for detecting
 * kinda_horizontal/kinda_vertical alignment.
 */
export function useAlignmentSnapEffect(
  currentPosition: [number, number] | null,
  drawLastPoint?: [number, number] | null,
) {
  const setAlignmentSnap = useSketchEditorStore(s => s.setAlignmentSnap)

  useEffect(() => {
    if (!currentPosition || !drawLastPoint) {
      setAlignmentSnap(null, null, null)
      return
    }

    const alignment = detectDrawAlignment(currentPosition, drawLastPoint)
    if (alignment) {
      setAlignmentSnap(alignment.point, alignment.kind, alignment.vertexId)
    } else {
      setAlignmentSnap(null, null, null)
    }
  }, [currentPosition, drawLastPoint, setAlignmentSnap])
}
