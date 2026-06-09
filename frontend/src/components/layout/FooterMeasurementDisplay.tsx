import { useMemo } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { computeMeasurements } from '@/utils/geometry/computeMeasurements'
import type { Sketch, BodyResult } from '@/types/cad'

interface FooterMeasurementDisplayProps {
  sketch: Sketch
  measurementIcon?: string
  solveResults?: Record<string, unknown>
  bodies?: Record<string, BodyResult>
}

export default function FooterMeasurementDisplay({
  sketch,
  measurementIcon,
  solveResults,
  bodies,
}: FooterMeasurementDisplayProps) {
  const selection = useSketchEditorStore(s => s.normalSelection)

  // Compute measurements for current selection
  const measurements = useMemo(() => {
    return computeMeasurements(selection, sketch, solveResults, bodies)
  }, [selection, sketch, solveResults, bodies])

  if (measurements.length === 0) {
    return null
  }

  return (
    <div className="measurement-display">
      {measurements.map((m, idx) => (
        <div key={idx} className="measurement-item">
          <img className="measurement-icon" src={measurementIcon} alt="" />
          <span>{m}</span>
        </div>
      ))}
    </div>
  )
}
