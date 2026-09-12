import type { PartFeature, Mutation } from '@/types/cad'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import { EDITOR_SCHEMAS } from '@/components/editors/featureEditorSchemas'
import { PlaneEditor } from '@/components/editors/PlaneEditor'
import { PlaneSelector } from '@/components/sketch/PlaneSelector'
import { useFileMeta } from '@/stores/fileRegistry'
import { formatBytes } from '@/utils/formatBytes'

interface FeatureItemEditorsProps {
  feature: PartFeature
  editingFeatureId: string | null
  doc: { features?: PartFeature[] } | null
  onMutation: (m: Mutation) => void
  features: PartFeature[]
  partLabels: Record<string, string>
}

const BUILT_IN_IDS = new Set(['Origin', 'Top', 'Front', 'Right'])

// The row is its own component because useFileMeta is a hook: FeatureItemEditors
// returns early for a feature that is not being edited, so the hook cannot live
// in the branch without breaking the rules of hooks.
function ImportStepFileRow({ fileId }: { fileId: string | undefined }) {
  const meta = useFileMeta(fileId)
  const detail = meta === 'missing' ? 'Missing file'
    : meta ? `${meta.name} (${formatBytes(meta.size)})` : 'Loading...'
  return (
    <div className="plane-editor">
      <div className="feature-field-row">
        <span className="feature-field-label">File</span>
        <span className="feature-field-value">{detail}</span>
      </div>
    </div>
  )
}

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
    return <ImportStepFileRow fileId={feature.file_id} />
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
