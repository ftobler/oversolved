import { usePartEditorStore } from '@/stores/partEditorStore'
import { partDisplayName } from '@/utils/core/partDisplayName'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorCallbacks } from '@/contexts/PartEditorContext'
import { usePartRelationHints } from '@/hooks/useRelationHint'
import featurePartIcon from '@/assets/icons/feature-part.svg'
import iconEyeIcon from '@/assets/icons/icon-eye.svg'
import iconEyeOffIcon from '@/assets/icons/icon-eye-off.svg'
import iconDotsIcon from '@/assets/icons/dots.svg'

export function PartsList() {
  const doc = usePartEditorStore(s => s.doc)
  const parts = usePartEditorStore(s => s.parts)
  const visibleParts = usePartEditorStore(s => s.visibleParts)
  const partLabels = usePartEditorStore(s => s.partLabels)
  const selection = useSketchEditorStore(s => s.normalSelection)
  // The same derivation the Features card reads, so the two cards cannot
  // disagree about which part a selected face or edge belongs to.
  const relatedIds = usePartRelationHints().tree

  const {
    onToggleSelect,
    onRightClick,
    onMutation,
  } = usePartEditorCallbacks()

  const handleClick = (partId: string) => {
    onToggleSelect(`@${partId}`)
  }

  return (
    <div className="sidebar-bottom glass-panel">
      <div className="sidebar-header">Parts</div>
      <ul className="parts-list">
        {doc && Object.keys(parts || {}).length === 0 ? (
          <li className="empty">No parts</li>
        ) : (
          Object.entries(parts || {}).map(([bodyId]) => {
            const isHidden = visibleParts ? !visibleParts.has(bodyId) : false
            const partLabel = partDisplayName(bodyId, partLabels, Object.keys(parts || {}))
            return (
              <li
                key={bodyId}
                className={`part-item ${selection.has(`@${bodyId}`) ? 'selected' : ''} ${relatedIds.has(`@${bodyId}`) ? 'related' : ''}`}
                onClick={() => handleClick(bodyId)}
              >
                <img className="part-icon" src={featurePartIcon} alt="" />
                <span className="part-name">{partLabel}</span>
                  <button
                    className="part-visibility-btn"
                    onClick={(e) => { e.stopPropagation(); onMutation({ type: 'set_body_visibility', bodyId, visible: isHidden }) }}
                    title={isHidden ? 'Show' : 'Hide'}
                  >
                    <img src={isHidden ? iconEyeOffIcon : iconEyeIcon} alt={isHidden ? 'Hidden' : 'Visible'} />
                  </button>
                <button
                  className="part-context-btn"
                  onClick={(e) => { e.stopPropagation(); onRightClick([e.clientX, e.clientY], `body:${bodyId}`) }}
                  title="More options"
                >
                  <img src={iconDotsIcon} alt="Options" />
                </button>
              </li>
            )
          })
        )}
      </ul>
    </div>
  )
}
