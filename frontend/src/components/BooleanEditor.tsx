import React from 'react'
import type { PartFeature, Mutation, PendingPickField, BooleanFeatureDef } from '../types/cad'
import { PickChip } from './PickChip'

interface BooleanEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
  pendingPickField: PendingPickField | null
  setPendingPickField: (field: PendingPickField | null) => void
  features?: PartFeature[]
  partLabels?: Record<string, string>
}

export const BooleanEditor: React.FC<BooleanEditorProps> = ({ feature, onMutation, pendingPickField, setPendingPickField, features, partLabels }) => {
  const bool = feature.boolean ?? { operation: 'union', target: '', tools: [] }
  const fid = feature.id
  const isPickingTarget = pendingPickField?.featureId === fid && pendingPickField?.field === 'boolean_target'
  const isPickingTool = pendingPickField?.featureId === fid && pendingPickField?.field === 'boolean_tool'

  return (
    <div className="plane-editor">
      <div className="feature-field-row">
        <span className="feature-field-label">Operation</span>
        <select
          className="feature-field-select"
          aria-label="Boolean operation"
          value={bool.operation}
          onChange={(e) => {
            e.stopPropagation()
            onMutation({ type: 'set_boolean_operation', featureId: fid, operation: e.target.value as BooleanFeatureDef['operation'] })
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="union">Union</option>
          <option value="subtract">Subtract</option>
          <option value="intersect">Intersect</option>
        </select>
      </div>
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Target</span>
        <PickChip
          values={bool.target ? [bool.target] : []}
          isPicking={isPickingTarget}
          onActivate={() => {
            if (isPickingTarget) setPendingPickField(null)
            else setPendingPickField({ featureId: fid, field: 'boolean_target' })
          }}
          onRemove={() => onMutation({ type: 'set_boolean_target', featureId: fid, target: '' })}
          emptyText="(pick target)"
          features={features}
          partLabels={partLabels}
        />
      </div>
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Tools</span>
        <PickChip
          values={bool.tools}
          isPicking={isPickingTool}
          onActivate={() => {
            setPendingPickField({ featureId: fid, field: 'boolean_tool' })
          }}
          onRemove={(index) => onMutation({ type: 'remove_boolean_tool', featureId: fid, tool: bool.tools[index] })}
          onReorder={(from, to) => onMutation({ type: 'reorder_pick_field', featureId: fid, field: 'tools', fromIndex: from, toIndex: to })}
          features={features}
          partLabels={partLabels}
        />
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Keep tools</span>
        <input
          type="checkbox"
          checked={bool.keep_tools ?? false}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            onMutation({ type: 'set_boolean_keep_tools', featureId: fid, keepTools: e.target.checked })
          }}
        />
      </div>
    </div>
  )
}