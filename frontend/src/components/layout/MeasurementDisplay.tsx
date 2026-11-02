import { useMemo } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { computeMeasurements } from '@/utils/geometry/computeMeasurements'
import MeasurementList from '@/components/layout/MeasurementList'
import type { Sketch, BodyResult, LengthUnit } from '@/types/cad'

interface MeasurementDisplayProps {
  sketch: Sketch
  measurementIcon?: string
  solveResults?: Record<string, unknown>
  bodies?: Record<string, BodyResult>
  // The part document's unit; the numbers are in it already, only the suffix
  // follows.
  lengthUnit?: LengthUnit
}

// The part editor's measurement readout for the current selection. Lives in
// the viewport's bottom-right HUD, under the orientation cube.
export default function MeasurementDisplay({
  sketch,
  measurementIcon,
  solveResults,
  bodies,
  lengthUnit = 'mm',
}: MeasurementDisplayProps) {
  const selection = useSketchEditorStore(s => s.normalSelection)

  // Compute measurements for current selection
  const measurements = useMemo(() => {
    return computeMeasurements(selection, sketch, solveResults, bodies, lengthUnit)
  }, [selection, sketch, solveResults, bodies, lengthUnit])

  return <MeasurementList measurements={measurements} measurementIcon={measurementIcon} />
}
