import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorCallbacks } from '@/contexts/PartEditorContext'
import featurePartIcon from '@/assets/icons/feature-part.svg'
import iconEyeIcon from '@/assets/icons/icon-eye.svg'
import iconEyeOffIcon from '@/assets/icons/icon-eye-off.svg'
import iconDotsIcon from '@/assets/icons/dots.svg'

interface BodyPartsListProps {
  splitPercent: number
}

export function BodyPartsList({ splitPercent }: BodyPartsListProps) {
  const bodies = usePartEditorStore(s => s.bodies)
  const visibleBodies = usePartEditorStore(s => s.visibleBodies)
  const partLabels = usePartEditorStore(s => s.partLabels)
  const selection = useSketchEditorStore(s => s.normalSelection)

  const {
    onToggleSelect,
    onRightClick,
  } = usePartEditorCallbacks()

  const handleClick = (bodyId: string) => {
    onToggleSelect(`@${bodyId}`)
  }

  return (
    <div className="sidebar-bottom" style={{ height: `${100 - splitPercent}%` }}>
      <div className="sidebar-header">Parts</div>
      <ul className="parts-list">
        {Object.keys(bodies || {}).length === 0 ? (
          <li className="empty">No parts</li>
        ) : (
          Object.entries(bodies || {}).map(([bodyId], index) => {
            const isHidden = visibleBodies ? !visibleBodies.has(bodyId) : false
            const partLabel = partLabels?.[bodyId] ?? `part ${index + 1}`
            return (
              <li
                key={bodyId}
                className={`part-item ${selection.has(`@${bodyId}`) ? 'selected' : ''}`}
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
