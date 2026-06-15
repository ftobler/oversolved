import type { PartFeature, Mutation } from '@/types/cad'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import { EDITOR_SCHEMAS } from '@/components/editors/featureEditorSchemas'
import { PlaneEditor } from '@/components/editors/PlaneEditor'
import { PlaneSelector } from '@/components/sketch/PlaneSelector'

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
  if (editingFeatureId !== feature.id) return null

  const kind = feature.kind

  if (kind === 'plane' && !BUILT_IN_IDS.has(feature.id)) {
    return (
      <PlaneEditor
        feature={feature}
        featureDef={doc?.features?.find(f => f.id === feature.id)}
        onMutation={onMutation}
        features={features}
        partLabels={partLabels}
      />
    )
  }

  if (kind === 'sketch') {
    return (
      <PlaneSelector
        feature={feature}
        featureDef={doc?.features?.find(f => f.id === feature.id)}
        onMutation={onMutation}
        features={features}
        partLabels={partLabels}
      />
    )
  }

  if (kind === 'import_step') {
    return (
      <div className="plane-editor">
        <div className="feature-field-row">
          <span className="feature-field-label">File</span>
          <span className="feature-field-value">{feature.file_id ?? '\u2014'}</span>
        </div>
      </div>
    )
  }

  const schema = EDITOR_SCHEMAS[kind]
  if (!schema) return null

  return (
    <FeatureEditor
      feature={feature}
      onMutation={onMutation}
      features={features}
      partLabels={partLabels}
      schema={schema}
    />
  )
}
