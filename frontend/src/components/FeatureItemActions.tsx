import contextEditIcon from '@/assets/icons/context-edit.svg'
import iconDotsIcon from '@/assets/icons/dots.svg'
import iconEyeIcon from '@/assets/icons/icon-eye.svg'
import iconEyeOffIcon from '@/assets/icons/icon-eye-off.svg'
import okIcon from '@/assets/icons/dialog-ok.svg'
import cancelIcon from '@/assets/icons/dialog-cancel.svg'

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

  return (
    <div className="feature-item-actions">
      {kind === 'sketch' && showEditBtn && (
        <button className="feature-edit-btn" onClick={() => onEnterEditSketch(featureId)} title="Edit sketch">
          <img src={contextEditIcon} alt="Edit" />
        </button>
      )}
      {kind === 'plane' && !isBuiltIn && showEditBtn && (
        <button className="feature-edit-btn" onClick={(e) => { e.stopPropagation(); onEnterEditFeature(featureId) }} title="Edit plane">
          <img src={contextEditIcon} alt="Edit" />
        </button>
      )}
      {kind === 'extrude' && showEditBtn && (
        <button className="feature-edit-btn" onClick={(e) => { e.stopPropagation(); onEnterEditFeature(featureId) }} title="Edit extrude">
          <img src={contextEditIcon} alt="Edit" />
        </button>
      )}
      {kind === 'revolve' && showEditBtn && (
        <button className="feature-edit-btn" onClick={(e) => { e.stopPropagation(); onEnterEditFeature(featureId) }} title="Edit revolve">
          <img src={contextEditIcon} alt="Edit" />
        </button>
      )}
      {kind === 'revolve' && showExitBtn && (
        <>
          <button className="feature-ok-btn" onClick={(e) => { e.stopPropagation(); onEditCommit() }} title="OK">
            <img src={okIcon} alt="OK" />
          </button>
          <button className="feature-cancel-btn" onClick={(e) => { e.stopPropagation(); onEditCancel() }} title="Cancel">
            <img src={cancelIcon} alt="Cancel" />
          </button>
        </>
      )}
      {kind === 'fillet' && showEditBtn && (
        <button className="feature-edit-btn" onClick={(e) => { e.stopPropagation(); onEnterEditFeature(featureId) }} title="Edit fillet">
          <img src={contextEditIcon} alt="Edit" />
        </button>
      )}
      {kind === 'fillet' && showExitBtn && (
        <>
          <button className="feature-ok-btn" onClick={(e) => { e.stopPropagation(); onEditCommit() }} title="OK">
            <img src={okIcon} alt="OK" />
          </button>
          <button className="feature-cancel-btn" onClick={(e) => { e.stopPropagation(); onEditCancel() }} title="Cancel">
            <img src={cancelIcon} alt="Cancel" />
          </button>
        </>
      )}
      {kind === 'chamfer' && showEditBtn && (
        <button className="feature-edit-btn" onClick={(e) => { e.stopPropagation(); onEnterEditFeature(featureId) }} title="Edit chamfer">
          <img src={contextEditIcon} alt="Edit" />
        </button>
      )}
      {kind === 'chamfer' && showExitBtn && (
        <>
          <button className="feature-ok-btn" onClick={(e) => { e.stopPropagation(); onEditCommit() }} title="OK">
            <img src={okIcon} alt="OK" />
          </button>
          <button className="feature-cancel-btn" onClick={(e) => { e.stopPropagation(); onEditCancel() }} title="Cancel">
            <img src={cancelIcon} alt="Cancel" />
          </button>
        </>
      )}
      {kind === 'boolean' && showEditBtn && (
        <button className="feature-edit-btn" onClick={(e) => { e.stopPropagation(); onEnterEditFeature(featureId) }} title="Edit boolean">
          <img src={contextEditIcon} alt="Edit" />
        </button>
      )}
      {kind === 'boolean' && showExitBtn && (
        <>
          <button className="feature-ok-btn" onClick={(e) => { e.stopPropagation(); onEditCommit() }} title="OK">
            <img src={okIcon} alt="OK" />
          </button>
          <button className="feature-cancel-btn" onClick={(e) => { e.stopPropagation(); onEditCancel() }} title="Cancel">
            <img src={cancelIcon} alt="Cancel" />
          </button>
        </>
      )}
      {kind === 'array' && showEditBtn && (
        <button className="feature-edit-btn" onClick={(e) => { e.stopPropagation(); onEnterEditFeature(featureId) }} title="Edit array">
          <img src={contextEditIcon} alt="Edit" />
        </button>
      )}
      {kind === 'array' && showExitBtn && (
        <>
          <button className="feature-ok-btn" onClick={(e) => { e.stopPropagation(); onEditCommit() }} title="OK">
            <img src={okIcon} alt="OK" />
          </button>
          <button className="feature-cancel-btn" onClick={(e) => { e.stopPropagation(); onEditCancel() }} title="Cancel">
            <img src={cancelIcon} alt="Cancel" />
          </button>
        </>
      )}
      {kind === 'delete_body' && showEditBtn && (
        <button className="feature-edit-btn" onClick={(e) => { e.stopPropagation(); onEnterEditFeature(featureId) }} title="Edit delete body">
          <img src={contextEditIcon} alt="Edit" />
        </button>
      )}
      {kind === 'delete_body' && showExitBtn && (
        <>
          <button className="feature-ok-btn" onClick={(e) => { e.stopPropagation(); onEditCommit() }} title="OK">
            <img src={okIcon} alt="OK" />
          </button>
          <button className="feature-cancel-btn" onClick={(e) => { e.stopPropagation(); onEditCancel() }} title="Cancel">
            <img src={cancelIcon} alt="Cancel" />
          </button>
        </>
      )}
      {kind === 'hole' && showEditBtn && (
        <button className="feature-edit-btn" onClick={(e) => { e.stopPropagation(); onEnterEditFeature(featureId) }} title="Edit hole">
          <img src={contextEditIcon} alt="Edit" />
        </button>
      )}
      {kind === 'hole' && showExitBtn && (
        <>
          <button className="feature-ok-btn" onClick={(e) => { e.stopPropagation(); onEditCommit() }} title="OK">
            <img src={okIcon} alt="OK" />
          </button>
          <button className="feature-cancel-btn" onClick={(e) => { e.stopPropagation(); onEditCancel() }} title="Cancel">
            <img src={cancelIcon} alt="Cancel" />
          </button>
        </>
      )}
      {kind === 'transform' && showEditBtn && (
        <button className="feature-edit-btn" onClick={(e) => { e.stopPropagation(); onEnterEditFeature(featureId) }} title="Edit transform">
          <img src={contextEditIcon} alt="Edit" />
        </button>
      )}
      {kind === 'transform' && showExitBtn && (
        <>
          <button className="feature-ok-btn" onClick={(e) => { e.stopPropagation(); onEditCommit() }} title="OK">
            <img src={okIcon} alt="OK" />
          </button>
          <button className="feature-cancel-btn" onClick={(e) => { e.stopPropagation(); onEditCancel() }} title="Cancel">
            <img src={cancelIcon} alt="Cancel" />
          </button>
        </>
      )}
      {kind === 'mirror' && showEditBtn && (
        <button className="feature-edit-btn" onClick={(e) => { e.stopPropagation(); onEnterEditFeature(featureId) }} title="Edit mirror">
          <img src={contextEditIcon} alt="Edit" />
        </button>
      )}
      {kind === 'mirror' && showExitBtn && (
        <>
          <button className="feature-ok-btn" onClick={(e) => { e.stopPropagation(); onEditCommit() }} title="OK">
            <img src={okIcon} alt="OK" />
          </button>
          <button className="feature-cancel-btn" onClick={(e) => { e.stopPropagation(); onEditCancel() }} title="Cancel">
            <img src={cancelIcon} alt="Cancel" />
          </button>
        </>
      )}
      {kind === 'extrude' && showExitBtn && (
        <>
          <button className="feature-ok-btn" onClick={(e) => { e.stopPropagation(); onEditCommit() }} title="OK">
            <img src={okIcon} alt="OK" />
          </button>
          <button className="feature-cancel-btn" onClick={(e) => { e.stopPropagation(); onEditCancel() }} title="Cancel">
            <img src={cancelIcon} alt="Cancel" />
          </button>
        </>
      )}
      {kind === 'sketch' && showExitBtn && (
        <>
          <button className="feature-ok-btn" onClick={(e) => { e.stopPropagation(); onEditCommit() }} title="OK">
            <img src={okIcon} alt="OK" />
          </button>
          <button className="feature-cancel-btn" onClick={(e) => { e.stopPropagation(); onEditCancel() }} title="Cancel">
            <img src={cancelIcon} alt="Cancel" />
          </button>
        </>
      )}
      {kind === 'plane' && !isBuiltIn && showExitBtn && (
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
      {kind === 'sketch' && isEditing && (
        <button className="feature-visibility-btn disabled" title="Visible while editing" disabled>
          <img src={iconEyeIcon} alt="Visible" />
        </button>
      )}
      {(kind === 'extrude' || kind === 'revolve' || kind === 'fillet' || kind === 'chamfer' || kind === 'boolean' || kind === 'array' || kind === 'delete_body' || kind === 'import_step' || kind === 'mirror') && (
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
