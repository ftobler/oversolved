import { useMemo } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { computeMeasurement } from '@/utils/geometry/computeMeasurements'
import { useKernelMeasure } from '@/hooks/useKernelMeasure'
import MeasurementList from '@/components/layout/MeasurementList'
import type { MeasureSet } from '@/kernel/worker/solverProtocol'
import type { Sketch, BodyResult, LengthUnit } from '@/types/cad'

interface MeasurementDisplayProps {
  sketch: Sketch
  measurementIcon?: string
  solveResults?: Record<string, unknown>
  bodies?: Record<string, BodyResult>
  // The part document's unit; the numbers are in it already, only the suffix
  // follows.
  lengthUnit?: LengthUnit
  // The solve generation the rendered bodies belong to and the body set a pick
  // is in: the kernel readout names both, so a reply can never be shown against
  // geometry it was not asked about.
  generation?: string | null
  measureSet?: MeasureSet
}

// The part editor's measurement readout for the current selection. Lives in
// the viewport's bottom-right HUD, under the orientation cube.
//
// The sync readout paints at once. A cell the pair table sends to the kernel (a
// spline edge's length, a clearance) reserves its row and fills it when the
// Worker answers; while the reply is in flight the row is there and empty, so
// the HUD does not jump when it lands (K2).
export default function MeasurementDisplay({
  sketch,
  measurementIcon,
  solveResults,
  bodies,
  lengthUnit = 'mm',
  generation = null,
  measureSet = 'final',
}: MeasurementDisplayProps) {
  const selection = useSketchEditorStore(s => s.normalSelection)

  // Compute measurements for current selection
  const measurement = useMemo(() => {
    return computeMeasurement(selection, sketch, solveResults, bodies, lengthUnit)
  }, [selection, sketch, solveResults, bodies, lengthUnit])

  const kernel = useKernelMeasure(measurement.ask, generation, measureSet, lengthUnit)

  return (
    <MeasurementList
      measurements={[...measurement.lines, ...kernel.lines]}
      pending={kernel.pending}
      measurementIcon={measurementIcon}
    />
  )
}
