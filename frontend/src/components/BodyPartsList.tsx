import React from 'react'
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

export const BodyPartsList: React.FC<BodyPartsListProps> = ({ splitPercent }) => {
  const bodies = usePartEditorStore(s => s.bodies)
  const visibleBodies = usePartEditorStore(s => s.visibleBodies)
  const partLabels = usePartEditorStore(s => s.partLabels)
  const selection = useSketchEditorStore(s => s.normalSelection)
  const pendingPickField = useSketchEditorStore(s => s.pendingPickField)

  const {
    onToggleSelect,
    onRightClick,
    onMutation,
    onToggleBodyVisibility,
  } = usePartEditorCallbacks()
  const onSetPendingPickField = useSketchEditorStore(s => s.setPendingPickField)

  const handleClick = (bodyId: string) => {
    if (pendingPickField?.field === 'merge_target') {
      const mutationType = pendingPickField.hostKind === 'revolve'
        ? 'set_revolve_merge_target'
        : 'set_extrude_merge_target'
      onMutation({ type: mutationType, featureId: pendingPickField.featureId, mergeTarget: '@' + bodyId })
      onSetPendingPickField(null)
    } else if (pendingPickField?.field === 'boolean_target') {
      onMutation({ type: 'set_boolean_target', featureId: pendingPickField.featureId, target: '@' + bodyId })
      onSetPendingPickField(null)
    } else if (pendingPickField?.field === 'boolean_tool') {
      onMutation({ type: 'add_boolean_tool', featureId: pendingPickField.featureId, tool: '@' + bodyId })
    } else if (pendingPickField?.field === 'body' && pendingPickField?.hostKind === 'transform') {
      onMutation({ type: 'set_transform_field', featureId: pendingPickField.featureId, field: 'body', value: '@' + bodyId })
      onSetPendingPickField(null)
    } else if (pendingPickField?.field === 'body' && pendingPickField?.hostKind === 'mirror') {
      onMutation({ type: 'set_mirror_field', featureId: pendingPickField.featureId, field: 'body', value: '@' + bodyId })
      onSetPendingPickField(null)
    } else if (pendingPickField?.field === 'body' && pendingPickField?.hostKind === 'delete_body') {
      onMutation({ type: 'set_delete_body_target', featureId: pendingPickField.featureId, body: '@' + bodyId })
      onSetPendingPickField(null)
    } else {
      onToggleSelect(`@${bodyId}`)
    }
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
                {onToggleBodyVisibility && (
                  <button
                    className="part-visibility-btn"
                    onClick={(e) => { e.stopPropagation(); onToggleBodyVisibility(bodyId) }}
                    title={isHidden ? 'Show' : 'Hide'}
                  >
                    <img src={isHidden ? iconEyeOffIcon : iconEyeIcon} alt={isHidden ? 'Hidden' : 'Visible'} />
                  </button>
                )}
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
