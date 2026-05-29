import type { PartFeature, Mutation } from '@/types/cad'
import { PlaneEditor } from '@/components/PlaneEditor'
import { PlaneSelector } from '@/components/PlaneSelector'
import { ExtrudeEditor } from '@/components/ExtrudeEditor'
import { RevolveEditor } from '@/components/RevolveEditor'
import { SweepEditor } from '@/components/SweepEditor'
import { FilletEditor } from '@/components/FilletEditor'
import { ChamferEditor } from '@/components/ChamferEditor'
import { BooleanEditor } from '@/components/BooleanEditor'
import { HoleEditor } from '@/components/HoleEditor'
import { TransformEditor } from '@/components/TransformEditor'
import { MirrorEditor } from '@/components/MirrorEditor'
import ArrayEditor from '@/components/ArrayEditor'
import CircularArrayEditor from '@/components/CircularArrayEditor'
import { DeleteBodyEditor } from '@/components/DeleteBodyEditor'

interface FeatureItemEditorsProps {
  feature: PartFeature
  editingFeatureId: string | null
  doc: { features?: PartFeature[] } | null
  onMutation: (m: Mutation) => void
  features: PartFeature[]
  partLabels: Record<string, string>
}

const BUILT_IN_IDS = new Set(['Origin', 'Top', 'Front', 'Right'])

export function FeatureItemEditors({
  feature,
  editingFeatureId,
  doc,
  onMutation,
  features,
  partLabels,
}: FeatureItemEditorsProps) {
  const fps = features
  const labels = partLabels

  return (
    <>
      {feature.kind === 'plane' && !BUILT_IN_IDS.has(feature.id) && feature.id === editingFeatureId && (
        <PlaneEditor
          feature={feature}
          featureDef={doc?.features?.find(f => f.id === feature.id)}
          onMutation={onMutation}
          features={fps}
          partLabels={labels}
        />
      )}
      {feature.kind === 'sketch' && feature.id === editingFeatureId && (
        <PlaneSelector
          feature={feature}
          featureDef={doc?.features?.find(f => f.id === feature.id)}
          onMutation={onMutation}
          features={fps}
          partLabels={labels}
        />
      )}
      {feature.kind === 'extrude' && editingFeatureId === feature.id && (
        <ExtrudeEditor
          feature={feature}
          onMutation={onMutation}
          features={fps}
          partLabels={labels}
        />
      )}
      {feature.kind === 'revolve' && editingFeatureId === feature.id && (
        <RevolveEditor
          feature={feature}
          onMutation={onMutation}
          features={fps}
          partLabels={labels}
        />
      )}
      {feature.kind === 'sweep' && editingFeatureId === feature.id && (
        <SweepEditor
          feature={feature}
          onMutation={onMutation}
          features={fps}
          partLabels={labels}
        />
      )}
      {feature.kind === 'import_step' && feature.id === editingFeatureId && (
        <div className="plane-editor">
          <div className="feature-field-row">
            <span className="feature-field-label">File</span>
            <span className="feature-field-value">{feature.file_id ?? '—'}</span>
          </div>
        </div>
      )}
      {feature.kind === 'fillet' && editingFeatureId === feature.id && (
        <FilletEditor
          feature={feature}
          onMutation={onMutation}
          features={fps}
          partLabels={labels}
        />
      )}
      {feature.kind === 'chamfer' && editingFeatureId === feature.id && (
        <ChamferEditor
          feature={feature}
          onMutation={onMutation}
          features={fps}
          partLabels={labels}
        />
      )}
      {feature.kind === 'boolean' && editingFeatureId === feature.id && (
        <BooleanEditor
          feature={feature}
          onMutation={onMutation}
          features={fps}
          partLabels={labels}
        />
      )}
      {feature.kind === 'array' && editingFeatureId === feature.id && (
        <ArrayEditor
          feature={feature}
          onMutation={onMutation}
          features={fps}
          partLabels={labels}
        />
      )}
      {feature.kind === 'circular_array' && editingFeatureId === feature.id && (
        <CircularArrayEditor
          feature={feature}
          onMutation={onMutation}
          features={fps}
          partLabels={labels}
        />
      )}
      {feature.kind === 'delete_body' && editingFeatureId === feature.id && (
        <DeleteBodyEditor
          feature={feature}
          onMutation={onMutation}
          features={fps}
          partLabels={labels}
        />
      )}
      {feature.kind === 'hole' && editingFeatureId === feature.id && (
        <HoleEditor
          feature={feature}
          onMutation={onMutation}
          features={fps}
          partLabels={labels}
        />
      )}
      {feature.kind === 'transform' && editingFeatureId === feature.id && (
        <TransformEditor
          feature={feature}
          onMutation={onMutation}
          features={fps}
          partLabels={labels}
        />
      )}
      {feature.kind === 'mirror' && editingFeatureId === feature.id && (
        <MirrorEditor
          feature={feature}
          onMutation={onMutation}
          features={fps}
          partLabels={labels}
        />
      )}
    </>
  )
}
