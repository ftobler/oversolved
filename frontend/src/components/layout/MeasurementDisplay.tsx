import { useMemo } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { computeMeasurements } from '@/utils/geometry/computeMeasurements'
import MeasurementList from '@/components/layout/MeasurementList'
import type { Sketch, BodyResult } from '@/types/cad'

interface MeasurementDisplayProps {
  sketch: Sketch
  measurementIcon?: string
  solveResults?: Record<string, unknown>
  bodies?: Record<string, BodyResult>
}

// The part editor's measurement readout for the current selection. Lives in
// the viewport's bottom-right HUD, under the orientation cube.
export default function MeasurementDisplay({
  sketch,
  measurementIcon,
  solveResults,
  bodies,
}: MeasurementDisplayProps) {
  const selection = useSketchEditorStore(s => s.normalSelection)

  // Compute measurements for current selection
  const measurements = useMemo(() => {
    return computeMeasurements(selection, sketch, solveResults, bodies)
  }, [selection, sketch, solveResults, bodies])

  return <MeasurementList measurements={measurements} measurementIcon={measurementIcon} />
}
