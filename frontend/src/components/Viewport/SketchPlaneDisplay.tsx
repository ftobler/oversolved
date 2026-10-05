import { PlaneLabel, PlaneSurface } from '@/components/Viewport/PlaneVisual'
import { builtinPlaneRotation } from '@/components/Viewport/planeConstants'

// The active sketch's plane quad. A leaf component (no Viewport barrel, no
// Canvas) so it renders and tests without the rest of the viewport tree.

export interface SketchPlaneDisplayProps {
  planeQuery: string
  size: number
  sketchLabel?: string
}

export function SketchPlaneDisplay({ planeQuery, size, sketchLabel }: SketchPlaneDisplayProps) {
  const rotation = builtinPlaneRotation(planeQuery)
  if (!rotation) return null

  return (
    <group rotation={rotation}>
      <PlaneSurface
        size={size}
      />
      {sketchLabel && (
        <PlaneLabel x={-size/2} y={size/2}>
          {sketchLabel}
        </PlaneLabel>
      )}
    </group>
  )
}
