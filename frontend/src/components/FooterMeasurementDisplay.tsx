import { useMemo } from 'react'
import { useSketchEditorStore } from '../stores/sketchEditorStore'
import { computeMeasurements } from '../utils/computeMeasurements'
import type { Sketch } from '../types/cad'

interface FooterMeasurementDisplayProps {
  sketch: Sketch
  measurementIcon?: string
}

export default function FooterMeasurementDisplay({
  sketch,
  measurementIcon,
}: FooterMeasurementDisplayProps) {
  const selection = useSketchEditorStore(s => s.selection)

  // Compute measurements for current selection
  const measurements = useMemo(() => {
    return computeMeasurements(selection, sketch)
  }, [selection, sketch])

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
