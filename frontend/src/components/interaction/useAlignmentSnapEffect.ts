import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { ALIGNMENT_TOLERANCE_DEG, ALIGNMENT_TOLERANCE_DIST } from '@/registry'
import { p2w } from '@/components/sketch_helpers'

export interface DrawAlignmentResult {
  kind: 'kinda_horizontal' | 'kinda_vertical'
  point: [number, number]
  vertexId: 'draw:last'
}

export function isAlignmentSnap(
  dx: number, dy: number, normalToleranceWorld: number,
): 'kinda_horizontal' | 'kinda_vertical' | null {
  const dist = Math.hypot(dx, dy)
  if (dist < 0.001) return null

  const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI)
  const normalizedAngle = ((angleDeg % 180) + 180) % 180

  const withinAngle = (targetCenter: number) => {
    const diff = Math.abs(normalizedAngle - targetCenter)
    return diff < ALIGNMENT_TOLERANCE_DEG || diff > 180 - ALIGNMENT_TOLERANCE_DEG
  }

  if (withinAngle(0)) {
    if (Math.abs(dy) < normalToleranceWorld) return 'kinda_horizontal'
  }
  if (withinAngle(90)) {
    if (Math.abs(dx) < normalToleranceWorld) return 'kinda_vertical'
  }
  return null
}

export function detectDrawAlignment(
  currentPosition: [number, number],
  drawLastPoint: [number, number],
  normalToleranceWorld: number,
): DrawAlignmentResult | null {
  const dx = currentPosition[0] - drawLastPoint[0]
  const dy = currentPosition[1] - drawLastPoint[1]
  const kind = isAlignmentSnap(dx, dy, normalToleranceWorld)
  if (!kind) return null
  return { kind, point: drawLastPoint, vertexId: 'draw:last' }
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
  const { camera } = useThree()

  useEffect(() => {
    if (!currentPosition || !drawLastPoint) {
      setAlignmentSnap(null, null, null)
      return
    }

    const normalToleranceWorld = ALIGNMENT_TOLERANCE_DIST * p2w(camera)
    const alignment = detectDrawAlignment(currentPosition, drawLastPoint, normalToleranceWorld)
    if (alignment) {
      setAlignmentSnap(alignment.point, alignment.kind, alignment.vertexId)
    } else {
      setAlignmentSnap(null, null, null)
    }
  }, [currentPosition, drawLastPoint, setAlignmentSnap, camera])
}
