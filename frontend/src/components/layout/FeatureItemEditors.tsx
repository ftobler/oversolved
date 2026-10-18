import type { PartFeature, Mutation } from '@/types/cad'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import { EDITOR_SCHEMAS } from '@/components/editors/featureEditorSchemas'
import { PlaneEditor } from '@/components/editors/PlaneEditor'
import { PlaneSelector } from '@/components/sketch/PlaneSelector'
import { useFileMeta } from '@/stores/fileRegistry'
import { formatBytes } from '@/utils/formatBytes'
import { BUILTIN_FEATURE_IDS } from '@/components/layout/builtinFeatureIds'
import { StatusMessage } from '@/components/shared/StatusMessage'
import { NO_MARK, type StatusMark } from '@/utils/core/statusMark'

interface FeatureItemEditorsProps {
  feature: PartFeature
  editingFeatureId: string | null
  doc: { features?: PartFeature[] } | null
  onMutation: (m: Mutation) => void
  features: PartFeature[]
  partLabels: Record<string, string>
  // The feature's mark from the last solve, the same one its tree row shows.
  status?: StatusMark
}

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

/**
 * The open editor of the feature being edited, headed by the feature's status
 * line. The line is drawn here, once, for every kind (schema editors, plane,
 * sketch plane, STEP import), so no editor carries its own failure display: a
 * failed build reads the same in every dialog and matches the tree row.
 */
export function FeatureItemEditors({ status = NO_MARK, ...props }: FeatureItemEditorsProps) {
  if (props.editingFeatureId !== props.feature.id) return null
  const editor = editorFor(props)
  if (editor === null) return null
  return (
    <>
      <StatusMessage mark={status} />
      {editor}
    </>
  )
}

/**
 * Whether the feature kind has an editor body at all. FeatureItemEditors
 * renders nothing exactly when this is false (a built-in plane, a kind with no
 * schema), which is the check the right-side panel needs before drawing its
 * frame around an empty body. Keep this in step with `editorFor` below.
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure kind predicate exported beside the editor component
export function featureHasEditor(feature: PartFeature): boolean {
  if (feature.kind === 'plane') return !BUILTIN_FEATURE_IDS.has(feature.id)
  if (feature.kind === 'sketch' || feature.kind === 'import_step') return true
  // Own-property check, as in EDIT_LABELS: a kind like 'constructor' must not
  // read a prototype member as an editor schema.
  return Object.prototype.hasOwnProperty.call(EDITOR_SCHEMAS, feature.kind)
}

function editorFor({
  feature,
  doc,
  onMutation,
  features,
  partLabels,
}: Omit<FeatureItemEditorsProps, 'status'>) {
  const kind = feature.kind

  if (kind === 'plane' && !BUILTIN_FEATURE_IDS.has(feature.id)) {
    const featureDef = doc?.features?.find(f => f.id === feature.id)
    return (
      <PlaneEditor
        feature={feature}
        featureDef={featureDef?.kind === 'plane' ? featureDef : undefined}
        onMutation={onMutation}
        features={features}
        partLabels={partLabels}
      />
    )
  }

  if (kind === 'sketch') {
    const featureDef = doc?.features?.find(f => f.id === feature.id)
    return (
      <PlaneSelector
        feature={feature}
        featureDef={featureDef?.kind === 'sketch' ? featureDef : undefined}
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
