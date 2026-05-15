import type { PartFeature, Mutation, PendingPickField } from '@/types/cad'
import { PlaneEditor } from '@/components/PlaneEditor'
import { PlaneSelector } from '@/components/PlaneSelector'
import { ExtrudeEditor } from '@/components/ExtrudeEditor'
import { RevolveEditor } from '@/components/RevolveEditor'
import { FilletEditor } from '@/components/FilletEditor'
import { ChamferEditor } from '@/components/ChamferEditor'
import { BooleanEditor } from '@/components/BooleanEditor'
import { HoleEditor } from '@/components/HoleEditor'
import { TransformEditor } from '@/components/TransformEditor'
import { MirrorEditor } from '@/components/MirrorEditor'
import ArrayEditor from '@/components/ArrayEditor'
import { DeleteBodyEditor } from '@/components/DeleteBodyEditor'

interface FeatureItemEditorsProps {
  feature: PartFeature
  editingFeatureId: string | null
  doc: { features?: PartFeature[] } | null
  onMutation: (m: Mutation) => void
  pendingPickField: PendingPickField | null
  setPendingPickField: (field: PendingPickField | null) => void
  selectionQuery: string | null
  features: PartFeature[]
  partLabels: Record<string, string>
  planeSelectionFeatureId: string | null
  setPlaneSelectionFeatureId: (id: string | null) => void
}

const BUILT_IN_IDS = new Set(['Origin', 'Top', 'Front', 'Right'])

export function FeatureItemEditors({
  feature,
  editingFeatureId,
  doc,
  onMutation,
  pendingPickField,
  setPendingPickField,
  selectionQuery,
  features,
  partLabels,
  planeSelectionFeatureId,
  setPlaneSelectionFeatureId,
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
          pendingPickField={pendingPickField}
          setPendingPickField={setPendingPickField}
          selectionQuery={selectionQuery}
          features={fps}
          partLabels={labels}
        />
      )}
      {feature.kind === 'sketch' && feature.id === editingFeatureId && (
        <PlaneSelector
          feature={feature}
          featureDef={doc?.features?.find(f => f.id === feature.id)}
          onMutation={onMutation}
          planeSelectionFeatureId={planeSelectionFeatureId}
          setPlaneSelectionFeatureId={setPlaneSelectionFeatureId}
          selectionQuery={selectionQuery}
          features={fps}
          partLabels={labels}
        />
      )}
      {feature.kind === 'extrude' && editingFeatureId === feature.id && (
        <ExtrudeEditor
          feature={feature}
          onMutation={onMutation}
          pendingPickField={pendingPickField}
          setPendingPickField={setPendingPickField}
          features={fps}
          partLabels={labels}
        />
      )}
      {feature.kind === 'revolve' && editingFeatureId === feature.id && (
        <RevolveEditor
          feature={feature}
          onMutation={onMutation}
          pendingPickField={pendingPickField}
          setPendingPickField={setPendingPickField}
          selectionQuery={selectionQuery}
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
          pendingPickField={pendingPickField}
          setPendingPickField={setPendingPickField}
          features={fps}
          partLabels={labels}
        />
      )}
      {feature.kind === 'chamfer' && editingFeatureId === feature.id && (
        <ChamferEditor
          feature={feature}
          onMutation={onMutation}
          pendingPickField={pendingPickField}
          setPendingPickField={setPendingPickField}
          features={fps}
          partLabels={labels}
        />
      )}
      {feature.kind === 'boolean' && editingFeatureId === feature.id && (
        <BooleanEditor
          feature={feature}
          onMutation={onMutation}
          pendingPickField={pendingPickField}
          setPendingPickField={setPendingPickField}
          features={fps}
          partLabels={labels}
        />
      )}
      {feature.kind === 'array' && editingFeatureId === feature.id && (
        <ArrayEditor
          feature={feature}
          onMutation={onMutation}
        />
      )}
      {feature.kind === 'delete_body' && editingFeatureId === feature.id && (
        <DeleteBodyEditor
          feature={feature}
          onMutation={onMutation}
          pendingPickField={pendingPickField}
          setPendingPickField={setPendingPickField}
          features={fps}
          partLabels={labels}
        />
      )}
      {feature.kind === 'hole' && editingFeatureId === feature.id && (
        <HoleEditor
          feature={feature}
          onMutation={onMutation}
          pendingPickField={pendingPickField}
          setPendingPickField={setPendingPickField}
          features={fps}
          partLabels={labels}
        />
      )}
      {feature.kind === 'transform' && editingFeatureId === feature.id && (
        <TransformEditor
          feature={feature}
          onMutation={onMutation}
          pendingPickField={pendingPickField}
          setPendingPickField={setPendingPickField}
          features={fps}
          partLabels={labels}
        />
      )}
      {feature.kind === 'mirror' && editingFeatureId === feature.id && (
        <MirrorEditor
          feature={feature}
          onMutation={onMutation}
          pendingPickField={pendingPickField}
          setPendingPickField={setPendingPickField}
          features={fps}
          partLabels={labels}
        />
      )}
    </>
  )
}
