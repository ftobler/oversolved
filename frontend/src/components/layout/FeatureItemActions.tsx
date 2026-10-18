import contextEditIcon from '@/assets/icons/context-edit.svg'
import iconDotsIcon from '@/assets/icons/dots.svg'
import iconEyeIcon from '@/assets/icons/icon-eye.svg'
import iconEyeOffIcon from '@/assets/icons/icon-eye-off.svg'
import { EDIT_LABELS } from '@/components/layout/featureItemKinds'

interface FeatureItemActionsProps {
  featureKind: string | undefined
  featureId: string
  isEditing: boolean
  isBuiltIn: boolean
  isOrigin: boolean
  isVisible: boolean
  hasVisibility: boolean
  onEnterEditSketch: (id: string) => void
  onEnterEditFeature: (id: string) => void
  onToggleVisibility: (id: string) => void
  onRightClick: (pos: [number, number], id: string) => void
}

// The row's action buttons. While the feature is edited the row keeps only its
// `editing` highlight and the context menu; the OK / Cancel pair and the editor
// body live in the floating FeatureEditPanel on the other side of the viewport.
export function FeatureItemActions({
  featureKind,
  featureId,
  isEditing,
  isBuiltIn,
  isOrigin,
  isVisible,
  hasVisibility,
  onEnterEditSketch,
  onEnterEditFeature,
  onToggleVisibility,
  onRightClick,
}: FeatureItemActionsProps) {
  const showEditBtn = !isEditing
  const showVisBtn = !isEditing
  const kind = featureKind

  // Own-property lookup so a kind like 'constructor' does not read a prototype
  // member as an edit label.
  const editLabel = kind !== undefined && Object.prototype.hasOwnProperty.call(EDIT_LABELS, kind)
    ? EDIT_LABELS[kind] : undefined
  // Built-in planes (the default origin planes) are not editable.
  const canEdit = editLabel !== undefined && (kind !== 'plane' || !isBuiltIn)

  return (
    <div className="feature-item-actions">
      {canEdit && showEditBtn && (
        kind === 'sketch' ? (
          <button className="feature-edit-btn" onClick={(e) => { e.stopPropagation(); onEnterEditSketch(featureId) }} title="Edit sketch">
            <img src={contextEditIcon} alt="Edit" />
          </button>
        ) : (
          <button className="feature-edit-btn" onClick={(e) => { e.stopPropagation(); onEnterEditFeature(featureId) }} title={`Edit ${editLabel}`}>
            <img src={contextEditIcon} alt="Edit" />
          </button>
        )
      )}
      {hasVisibility && showVisBtn && (
        <button
          className="feature-visibility-btn"
          onClick={(e) => { e.stopPropagation(); onToggleVisibility(featureId) }}
          title={isVisible ? 'Hide' : 'Show'}
        >
          <img src={isVisible ? iconEyeIcon : iconEyeOffIcon} alt={isVisible ? 'Visible' : 'Hidden'} />
        </button>
      )}
      {/* Reserve the visibility slot for every editable row that has no
          visibility button (sketch and plane own one), so the tridot aligns.
          Non-editable kinds (e.g. import_step) have neither an edit nor a
          visibility control, so they get no slot and their tridot sits first. */}
      {!isEditing && canEdit && kind !== 'sketch' && kind !== 'plane' && (
        <span className="feature-visibility-placeholder" />
      )}
      {!isBuiltIn && !isOrigin && (
        <button
          className="feature-context-btn"
          onClick={(e) => { e.stopPropagation(); onRightClick([e.clientX, e.clientY], featureId) }}
          title="More options"
        >
          <img src={iconDotsIcon} alt="Options" />
        </button>
      )}
    </div>
  )
}
