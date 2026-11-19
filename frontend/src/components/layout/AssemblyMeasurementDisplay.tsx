// The assembly viewport's measurement readout. Mirrors MeasurementDisplay (the
// part editor's), including its bottom-left slot in the viewport, but reads the
// assembly's own selection: the B-rep entity set,
// or the tree's part subject as a whole-instance pick. The picks resolve through
// the solved bundle's analytic facts, so the assembly states the same numbers
// the part editor does; a cell that needs OCC goes to the solver Worker with
// the parts and poses it names.

import { useMemo } from 'react'
import { useAssemblyStore } from '@/stores/assemblyStore'
import { computeAssemblyHud } from '@/utils/assemblyMeasurements'
import { useAssemblyKernelMeasure } from '@/hooks/useAssemblyKernelMeasure'
import { relativeTransform } from '@/utils/transform3d'
import { settledTransforms } from '@/utils/partManipulation'
import type { Transform3D } from '@/types/cad'
import MeasurementList from '@/components/layout/MeasurementList'

interface Props {
  measurementIcon?: string
}

export default function AssemblyMeasurementDisplay({ measurementIcon }: Props) {
  const entitySelection = useAssemblyStore(s => s.entitySelection)
  const entityMateRefs = useAssemblyStore(s => s.entityMateRefs)
  const anchors = useAssemblyStore(s => s.anchors)
  const shapeFacts = useAssemblyStore(s => s.shapeFacts)
  const subject = useAssemblyStore(s => s.subject)
  const doc = useAssemblyStore(s => s.doc)
  const transforms = useAssemblyStore(s => s.transforms)
  const settlingOffsets = useAssemblyStore(s => s.settlingOffsets)
  const pickGeometryPose = useAssemblyStore(s => s.pickGeometryPose)

  const drawn = useMemo(
    () => settledTransforms(transforms, settlingOffsets),
    [transforms, settlingOffsets],
  )

  // A committed drag the re-solve has not re-meshed yet draws the bodies at the
  // settling pose, and the ID buffer offsets its baked snapshot onto it. The
  // measurement follows the same relative pose, or the readout would describe
  // where the part used to be. No pending offset is the common case and needs no
  // record at all.
  const poseOffsets = useMemo<Record<string, Transform3D> | null>(() => {
    if (Object.keys(settlingOffsets).length === 0) return null
    const out: Record<string, Transform3D> = {}
    for (const handle of Object.keys(settlingOffsets)) {
      const baked = pickGeometryPose[handle]
      if (drawn[handle] && baked) out[handle] = relativeTransform(drawn[handle], baked)
    }
    return out
  }, [drawn, settlingOffsets, pickGeometryPose])

  const measurement = useMemo(
    () => computeAssemblyHud(entitySelection, {
      entityMateRefs,
      anchors,
      shapeFacts,
      poseOffsets,
      subjectHandle: subject?.kind === 'part' ? subject.handle : null,
    }),
    [entitySelection, entityMateRefs, anchors, shapeFacts, poseOffsets, subject],
  )

  const kernel = useAssemblyKernelMeasure(measurement.ask, doc, drawn)

  return (
    <MeasurementList
      measurements={[...measurement.lines, ...kernel.lines]}
      more={measurement.more}
      pending={kernel.pending}
      measurementIcon={measurementIcon}
    />
  )
}
