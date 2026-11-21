import { usePartEditorStore } from '@/stores/partEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import { usePartEditorCallbacks } from '@/contexts/PartEditorContext'
import { featureFailure } from '@/utils/core/featureFailure'
import { FeatureItemEditors, featureHasEditor } from '@/components/layout/FeatureItemEditors'
import { getFeatureIcon } from '@/components/layout/featureIcons'
import { StatusPanel } from '@/components/shared/StatusPanel'
import '@/components/layout/Glass.css'
import okIcon from '@/assets/icons/dialog-ok.svg'
import cancelIcon from '@/assets/icons/dialog-cancel.svg'

/**
 * The open feature editor as a floating card on the right side of the viewport:
 * the feature's icon and name over the OK / Cancel pair, then the
 * same editor body the tree row used to carry inline. The row no longer grows
 * a whole form when a feature opens; it keeps its `editing` highlight and swaps
 * its edit button for its own OK / Cancel pair (FeatureItemActions.tsx), so an
 * edit can also be ended where it started. The editor body itself lives only
 * here, in this panel.
 *
 * The body is FeatureItemEditors, unchanged, so every kind (schema editors,
 * plane, sketch plane selector, STEP import) reads exactly as it did in the
 * row. The feature's solve mark is the one thing kept out of the body: it is
 * its own glass card after this panel in the right column's flow, so an error
 * leaves the panel's own markup, size and content untouched.
 */
export function FeatureEditPanel() {
  const editingFeatureId = useEditorState(s => s.editingFeatureId)
  const features = usePartEditorStore(s => s.features)
  const doc = usePartEditorStore(s => s.doc)
  const partLabels = usePartEditorStore(s => s.partLabels)
  const solveResults = usePartEditorStore(s => s.solveResults)
  const parts = usePartEditorStore(s => s.parts)
  const { onEditCommit, onEditCancel, onMutation, onMutationBatch } = usePartEditorCallbacks()

  // Nothing open, or the open id names a feature with no editor body (a
  // built-in plane, say): the panel has nothing to draw and an empty frame
  // would only cover the model.
  const feature = editingFeatureId === null
    ? undefined
    : features.find(f => f.id === editingFeatureId)
  if (!feature || !featureHasEditor(feature)) return null

  // The feature's own last solve result, for a row that shows a solved value
  // (the linear pattern's directive-length spacing). A feature that never
  // solved has none, and the row stays hidden.
  const solved = solveResults[feature.id]
  const mark = featureFailure(feature.id, solveResults, parts)

  // Two siblings, not a wrapper: the part page mounts this inside the right
  // overlay stack, whose 12px gap is what separates the panel, the status card
  // and the bug report card after it.
  return (
    <>
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
            onMutationBatch={onMutationBatch}
            features={features}
            partLabels={partLabels}
            solved={solved}
          />
        </div>
      </div>
      <StatusPanel mark={mark} />
    </>
  )
}
