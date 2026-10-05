// The assembly viewport's measurement readout. Mirrors MeasurementDisplay (the
// part editor's), but reads the assembly's own selection and measures it off
// the solved anchor table rather than sketch geometry.

import { useMemo } from 'react'
import { useAssemblyStore } from '@/stores/assemblyStore'
import { computeAssemblyMeasurements } from '@/utils/assemblyMeasurements'
import MeasurementList from '@/components/layout/MeasurementList'

interface Props {
  measurementIcon?: string
}

export default function AssemblyMeasurementDisplay({ measurementIcon }: Props) {
  const entitySelection = useAssemblyStore(s => s.entitySelection)
  const entityMateRefs = useAssemblyStore(s => s.entityMateRefs)
  const anchors = useAssemblyStore(s => s.anchors)

  const measurements = useMemo(
    () => computeAssemblyMeasurements(entitySelection, entityMateRefs, anchors),
    [entitySelection, entityMateRefs, anchors],
  )

  return <MeasurementList measurements={measurements} measurementIcon={measurementIcon} />
}
