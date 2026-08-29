// The assembly viewport's measurement readout. Mirrors MeasurementDisplay (the
// part editor's), but reads the assembly's own selection and measures it off
// the solved anchor table rather than sketch geometry.

import { useMemo } from 'react'
import { useAssemblyStore } from '@/stores/assemblyStore'
import { computeAssemblyMeasurements } from '@/utils/assemblyMeasurements'

interface Props {
  measurementIcon?: string
}

export default function AssemblyMeasurementDisplay({ measurementIcon }: Props) {
  const selection = useAssemblyStore(s => s.selection)
  const entityMateRefs = useAssemblyStore(s => s.entityMateRefs)
  const anchors = useAssemblyStore(s => s.anchors)

  const measurements = useMemo(
    () => computeAssemblyMeasurements(selection, entityMateRefs, anchors),
    [selection, entityMateRefs, anchors],
  )

  if (measurements.length === 0) return null

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
