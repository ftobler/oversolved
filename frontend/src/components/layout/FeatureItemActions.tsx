import contextEditIcon from '@/assets/icons/context-edit.svg'
import iconDotsIcon from '@/assets/icons/dots.svg'
import iconEyeIcon from '@/assets/icons/icon-eye.svg'
import iconEyeOffIcon from '@/assets/icons/icon-eye-off.svg'
import okIcon from '@/assets/icons/dialog-ok.svg'
import cancelIcon from '@/assets/icons/dialog-cancel.svg'

// Feature kinds that expose edit (and, while editing, OK/Cancel) buttons, keyed
// to the word used in the edit tooltip. `sketch` is the lone exception: it edits
// via onEnterEditSketch rather than onEnterEditFeature (handled below).
const EDIT_LABELS: Record<string, string> = {
  sketch: 'sketch',
  plane: 'plane',
  extrude: 'extrude',
  revolve: 'revolve',
  sweep: 'sweep',
  fillet: 'fillet',
  chamfer: 'chamfer',
  boolean: 'boolean',
  array: 'array',
  circular_array: 'circular array',
  delete_body: 'delete body',
  hole: 'hole',
  transform: 'transform',
  mirror: 'mirror',
  variable: 'variable',
}

interface FeatureItemActionsProps {
  featureKind: string | undefined
  featureId: string
  isEditing: boolean
  isBuiltIn: boolean
  isOrigin: boolean
  isVisible: boolean
  hasVisibility: boolean
  onEnterEditSketch: (id: string) => void
  onExitEditSketch: () => void
  onEnterEditFeature: (id: string) => void
  onExitEditFeature: () => void
  onEditCommit: () => void
  onEditCancel: () => void
  onToggleVisibility: (id: string) => void
  onRightClick: (pos: [number, number], id: string) => void
}

export function FeatureItemActions({
  featureKind,
  featureId,
  isEditing,
  isBuiltIn,
  isOrigin,
  isVisible,
  hasVisibility,
  onEnterEditSketch,
  onExitEditSketch: _onExitEditSketch,
  onEnterEditFeature,
  onExitEditFeature: _onExitEditFeature,
  onEditCommit,
  onEditCancel,
  onToggleVisibility,
  onRightClick,
}: FeatureItemActionsProps) {
  const showEditBtn = !isEditing
  const showExitBtn = isEditing
  const showVisBtn = !isEditing
  const kind = featureKind

  const editLabel = kind ? EDIT_LABELS[kind] : undefined
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
          className="feature-visibility-btn"
          onClick={(e) => { e.stopPropagation(); onToggleVisibility(featureId) }}
          title={isVisible ? 'Hide' : 'Show'}
        >
          <img src={isVisible ? iconEyeIcon : iconEyeOffIcon} alt={isVisible ? 'Visible' : 'Hidden'} />
        </button>
      )}
      {!isEditing && (kind === 'extrude' || kind === 'revolve' || kind === 'sweep' || kind === 'fillet' || kind === 'chamfer' || kind === 'boolean' || kind === 'array' || kind === 'circular_array' || kind === 'delete_body' || kind === 'import_step' || kind === 'mirror' || kind === 'transform') && (
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
