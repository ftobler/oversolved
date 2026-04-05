import { useMemo } from 'react'
import { useSketchEditorStore } from '../stores/sketchEditorStore'
import { computeMeasurements } from '../utils/computeMeasurements'

interface FooterMeasurementDisplayProps {
  activeFeatureId?: string
  solveResults?: Record<string, any>
  measurementIcon?: string
}

export default function FooterMeasurementDisplay({
  activeFeatureId,
  solveResults = {},
  measurementIcon,
}: FooterMeasurementDisplayProps) {
  const selection = useSketchEditorStore(s => s.selection)

  // Get sketch data for active feature
  const sketch = useMemo(() => {
    const sr = activeFeatureId && solveResults?.[activeFeatureId]
    if (!sr) {
      return {}
    }
    return sr.solved || {}
  }, [activeFeatureId, solveResults])

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
