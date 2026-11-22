import { useMemo } from 'react'
import type { LengthUnit, PartFeature, Mutation } from '@/types/cad'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import { EDITOR_SCHEMAS } from '@/components/editors/featureEditorSchemas'
import { PlaneEditor } from '@/components/editors/PlaneEditor'
import { PlaneSelector } from '@/components/sketch/PlaneSelector'
import { useFileMeta } from '@/hooks/useFileMeta'
import { formatBytes } from '@/utils/formatBytes'
import { BUILTIN_FEATURE_IDS } from '@/utils/builtins'
import { lengthUnitOf } from '@/utils/lengthUnit'
import { variableScopeAt, laterVariablesAt } from '@/kernel/features/variable'

interface FeatureItemEditorsProps {
  feature: PartFeature
  editingFeatureId: string | null
  doc: { features?: PartFeature[]; length_unit?: LengthUnit } | null
  onMutation: (m: Mutation) => void
  // The group seam for a pick field's whole arriving batch (one undo step).
  onMutationBatch?: (mutations: Mutation[]) => void
  features: PartFeature[]
  partLabels: Record<string, string>
  // The feature's last solve result, for an editor row that shows a solved value.
  solved?: unknown
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
 * The open editor of the feature being edited, for every kind (schema editors,
 * plane, sketch plane, STEP import). The feature's own status mark is not part
 * of the form: its host (FeatureEditPanel) draws it as a separate card under
 * the panel, so no editor carries its own failure display and a mark reads the
 * same way in every dialog and in the tree row.
 */
export function FeatureItemEditors(props: FeatureItemEditorsProps) {
  if (props.editingFeatureId !== props.feature.id) return null
  // The scope folds parse every preceding variable, so the child owns them:
  // this component returns early, and a hook cannot sit after that.
  return <ScopedEditor {...props} />
}

/**
 * The editor body with its variable scope. The fold is the same positional one
 * the solve uses: a number field resolves only the variables above its own
 * row. A feature being added is already in the list at its insertion index, so
 * it needs no special case. Memoized on the feature list and index so typing in
 * a field does not re-parse the log on every keystroke.
 */
function ScopedEditor(props: FeatureItemEditorsProps) {
  const { feature, features } = props
  const index = features.findIndex(f => f.id === feature.id)
  const variables = useMemo(
    () => (index < 0 ? {} : variableScopeAt(features, index)),
    [features, index],
  )
  const laterVariables = useMemo(
    () => (index < 0 ? {} : laterVariablesAt(features, index, variables)),
    [features, index, variables],
  )
  return editorFor(props, variables, laterVariables)
}

/**
 * Whether the feature kind has an editor body at all. FeatureItemEditors
 * renders nothing exactly when this is false (a built-in plane, a kind with no
 * schema), which is the check the right-side panel needs before drawing its
 * frame around an empty body. __tests__/featureItemKinds.test.ts pins this
 * against the edit gate and the schema table.
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
  onMutationBatch,
  features,
  partLabels,
  solved,
}: FeatureItemEditorsProps, variables: Record<string, number>, laterVariables: Record<string, number>) {
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
        lengthUnit={lengthUnitOf(doc?.length_unit)}
        variables={variables}
        laterVariables={laterVariables}
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
      onMutationBatch={onMutationBatch}
      features={features}
      partLabels={partLabels}
      schema={schema}
      lengthUnit={lengthUnitOf(doc?.length_unit)}
      solved={solved}
      variables={variables}
      laterVariables={laterVariables}
    />
  )
}
