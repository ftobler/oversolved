import React from 'react'
import type { PartFeature, Mutation, PendingPickField, BooleanFeatureDef } from '../types/cad'

interface BooleanEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
  pendingPickField: PendingPickField | null
  setPendingPickField: (field: PendingPickField | null) => void
}

const Chip: React.FC<{ value: string; isPicking: boolean; onActivate: () => void; onRemove?: () => void; emptyText?: string }> = ({ value, isPicking, onActivate, onRemove, emptyText }) => {
  return (
    <div
      className={`feature-pick-chip ${!value ? 'empty' : ''} ${isPicking ? 'picking' : ''}`}
      onClick={(e) => { e.stopPropagation(); onActivate() }}
    >
      {value ? (
        <>
          <div className="feature-pick-chip-item">
            <span className="feature-pick-chip-item-text">{value}</span>
            {onRemove && (
              <button
                className="feature-pick-chip-item-remove"
                onClick={(e) => { e.stopPropagation(); onRemove() }}
                title="Remove"
              >×</button>
            )}
          </div>
        </>
      ) : (
        <span>{emptyText ?? '(none)'}</span>
      )}
    </div>
  )
}

const ListPickChip: React.FC<{ values: string[]; isPicking: boolean; onActivate: () => void; onRemove: (value: string) => void }> = ({ values, isPicking, onActivate, onRemove }) => {
  const isEmpty = values.length === 0
  return (
    <div
      className={`feature-pick-chip feature-pick-chip-list ${isEmpty ? 'empty' : ''} ${isPicking ? 'picking' : ''}`}
      onClick={(e) => { e.stopPropagation(); onActivate() }}
    >
      {values.map((v, i) => (
        <div key={i} className="feature-pick-chip-item">
          <span className="feature-pick-chip-item-text">{v}</span>
          <button
            className="feature-pick-chip-item-remove"
            onClick={(e) => { e.stopPropagation(); onRemove(v) }}
            title="Remove"
          >×</button>
        </div>
      ))}
    </div>
  )
}

export const BooleanEditor: React.FC<BooleanEditorProps> = ({ feature, onMutation, pendingPickField, setPendingPickField }) => {
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
      <div className="feature-field-row">
        <span className="feature-field-label">Target</span>
        <Chip
          value={bool.target}
          isPicking={isPickingTarget}
          onActivate={() => {
            if (isPickingTarget) setPendingPickField(null)
            else setPendingPickField({ featureId: fid, field: 'boolean_target' })
          }}
          emptyText="(pick target)"
        />
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Tools</span>
        <ListPickChip
          values={bool.tools}
          isPicking={isPickingTool}
          onActivate={() => {
            setPendingPickField({ featureId: fid, field: 'boolean_tool' })
          }}
          onRemove={(value) => onMutation({ type: 'remove_boolean_tool', featureId: fid, tool: value })}
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