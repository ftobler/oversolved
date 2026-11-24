import contextEditIcon from '@/assets/icons/context-edit.svg'
import iconDotsIcon from '@/assets/icons/dots.svg'
import iconEyeIcon from '@/assets/icons/icon-eye.svg'
import iconEyeOffIcon from '@/assets/icons/icon-eye-off.svg'
import okIcon from '@/assets/icons/dialog-ok.svg'
import cancelIcon from '@/assets/icons/dialog-cancel.svg'
import { EDIT_LABELS } from '@/components/layout/featureItemKinds'
import type { ContextMenuSurface } from '@/pages/buildContextMenu'

interface FeatureItemActionsProps {
  featureKind: string | undefined
  featureId: string
  isEditing: boolean
  isBuiltIn: boolean
  isOrigin: boolean
  isVisible: boolean
  hasVisibility: boolean
  isSuppressed?: boolean
  onEnterEditSketch: (id: string) => void
  onEnterEditFeature: (id: string) => void
  onEditCommit: () => void
  onEditCancel: () => void
  onToggleVisibility: (id: string) => void
  onRightClick: (pos: [number, number], id: string, surface?: ContextMenuSurface) => void
}

// The row's action buttons. While a feature is edited the edit button becomes
// the OK / Cancel pair in the same slot, so committing or abandoning an edit
// happens next to the button that opened it instead of across the viewport.
// The editor body itself lives in the floating FeatureEditPanel, which keeps
// its own pair for working at that end of the screen.
export function FeatureItemActions({
  featureKind,
  featureId,
  isEditing,
  isBuiltIn,
  isOrigin,
  isVisible,
  hasVisibility,
  isSuppressed = false,
  onEnterEditSketch,
  onEnterEditFeature,
  onEditCommit,
  onEditCancel,
  onToggleVisibility,
  onRightClick,
}: FeatureItemActionsProps) {
  const showEditBtn = !isEditing
  const showExitBtn = isEditing
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
        <button
          className={isSuppressed ? 'feature-edit-btn disabled' : 'feature-edit-btn'}
          disabled={isSuppressed}
          onClick={(e) => {
            e.stopPropagation()
            if (kind === 'sketch') onEnterEditSketch(featureId)
            else onEnterEditFeature(featureId)
          }}
          title={isSuppressed ? 'Unsuppress to edit' : kind === 'sketch' ? 'Edit sketch' : `Edit ${editLabel}`}
        >
          <img src={contextEditIcon} alt="Edit" />
        </button>
      )}
      {canEdit && showExitBtn && (
        <>
          <button className="feature-ok-btn" onClick={(e) => { e.stopPropagation(); onEditCommit() }} title="OK">
            <img src={okIcon} alt="OK" />
          </button>
          <button className="feature-cancel-btn" onClick={(e) => { e.stopPropagation(); onEditCancel() }} title="Cancel">
            <img src={cancelIcon} alt="Cancel" />
          </button>
        </>
      )}
      {hasVisibility && showVisBtn && (
        <button
          className={isSuppressed ? 'feature-visibility-btn suppressed' : 'feature-visibility-btn'}
          onClick={(e) => { e.stopPropagation(); onToggleVisibility(featureId) }}
          title={isVisible ? 'Hide' : 'Show'}
        >
          <img src={isVisible ? iconEyeIcon : iconEyeOffIcon} alt={isVisible ? 'Visible' : 'Hidden'} />
        </button>
      )}
      {/* Reserve the visibility slot on an editable kind the visibility table
          excludes (featureVisibilityKinds.ts), so the tridot stays aligned with
          its neighbours. Non-editable kinds get neither control, so their
          tridot sits first. */}
      {!isEditing && canEdit && !hasVisibility && (
        <span className="feature-visibility-placeholder" />
      )}
      {!isBuiltIn && !isOrigin && (
        <button
          className="feature-context-btn"
          onClick={(e) => { e.stopPropagation(); onRightClick([e.clientX, e.clientY], featureId, 'tree') }}
          title="More options"
        >
          <img src={iconDotsIcon} alt="Options" />
        </button>
      )}
    </div>
  )
}
