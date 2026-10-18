import { usePartEditorStore } from '@/stores/partEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import { usePartEditorCallbacks } from '@/contexts/PartEditorContext'
import { featureFailure } from '@/utils/core/featureFailure'
import { FeatureItemEditors, featureHasEditor } from '@/components/layout/FeatureItemEditors'
import { getFeatureIcon } from '@/components/layout/featureIcons'
import '@/components/layout/Glass.css'
import okIcon from '@/assets/icons/dialog-ok.svg'
import cancelIcon from '@/assets/icons/dialog-cancel.svg'

/**
 * The open feature editor as a floating card on the right side of the
 * viewport: the feature's icon and name over the OK / Cancel pair, then the
 * same editor body the tree row used to carry inline. The row no longer grows
 * a whole form when a feature opens; it only keeps its `editing` highlight
 * (FeatureTree.tsx), and this panel is the one place the editor lives.
 *
 * The body is FeatureItemEditors, unchanged, so every kind (schema editors,
 * plane, sketch plane selector, STEP import) reads exactly as it did in the
 * row, status line included.
 */
export function FeatureEditPanel() {
  const editingFeatureId = useEditorState(s => s.editingFeatureId)
  const features = usePartEditorStore(s => s.features)
  const doc = usePartEditorStore(s => s.doc)
  const partLabels = usePartEditorStore(s => s.partLabels)
  const solveResults = usePartEditorStore(s => s.solveResults)
  const bodies = usePartEditorStore(s => s.bodies)
  const { onEditCommit, onEditCancel, onMutation } = usePartEditorCallbacks()

  // Nothing open, or the open id names a feature with no editor body (a
  // built-in plane, say): the panel has nothing to draw and an empty frame
  // would only cover the model.
  const feature = editingFeatureId === null
    ? undefined
    : features.find(f => f.id === editingFeatureId)
  if (!feature || !featureHasEditor(feature)) return null

  return (
    <div className="glass-panel feature-edit-panel">
      <div className="feature-edit-panel-header">
        <img
          className="feature-icon"
          src={getFeatureIcon(feature.kind)}
          alt={feature.kind || 'feature'}
        />
        <span className="feature-edit-panel-title">{feature.label || feature.id}</span>
        <button className="feature-ok-btn" onClick={onEditCommit} title="OK">
          <img src={okIcon} alt="OK" />
        </button>
        <button className="feature-cancel-btn" onClick={onEditCancel} title="Cancel">
          <img src={cancelIcon} alt="Cancel" />
        </button>
      </div>
      <div className="feature-edit-panel-body">
        <FeatureItemEditors
          feature={feature}
          editingFeatureId={feature.id}
          doc={doc}
          onMutation={onMutation}
          features={features}
          partLabels={partLabels}
          status={featureFailure(feature.id, solveResults, bodies)}
        />
      </div>
    </div>
  )
}
