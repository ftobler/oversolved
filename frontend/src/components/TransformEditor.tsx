import React from 'react'
import type { PartFeature, Mutation, PendingPickField } from '../types/cad'

interface TransformEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
  pendingPickField: PendingPickField | null
  setPendingPickField: (field: PendingPickField | null) => void
}

const PickChip: React.FC<{ value: string | undefined; isPicking: boolean; onActivate: () => void; onClear: () => void }> = ({ value, isPicking, onActivate, onClear }) => {
  const isEmpty = !value || value === 'None'
  return (
    <div
      className={`feature-pick-chip ${isEmpty ? 'empty' : ''} ${isPicking ? 'picking' : ''}`}
      onClick={(e) => { e.stopPropagation(); onActivate() }}
    >
      {!isEmpty && (
        <div className="feature-pick-chip-item">
          <span className="feature-pick-chip-item-text">{value}</span>
          <button
            className="feature-pick-chip-item-remove"
            onClick={(e) => { e.stopPropagation(); onClear() }}
            title="Clear selection"
          >×</button>
        </div>
      )}
    </div>
  )
}

export const TransformEditor: React.FC<TransformEditorProps> = ({ feature, onMutation, pendingPickField, setPendingPickField }) => {
  const transform = feature.transform ?? { body: '', operation: 'new', translation: [0, 0, 0], rotation_angle: 0, scale: 1 }
  const fid = feature.id

  const isPicking = (field: string) => pendingPickField?.featureId === fid && pendingPickField.field === field

  const numField = (label: string, value: number | undefined, onBlur: (v: number) => void) => (
    <div className="feature-field-row">
      <span className="feature-field-label">{label}</span>
      <input
        type="number"
        className="feature-field-input"
        defaultValue={value ?? 0}
        onClick={(e) => e.stopPropagation()}
        onBlur={(e) => {
          const v = parseFloat(e.target.value)
          if (!isNaN(v)) onBlur(v)
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
      />
    </div>
  )

  return (
    <div className="plane-editor">
      <div className="feature-field-row">
        <span className="feature-field-label">Body</span>
        <PickChip
          value={transform.body}
          isPicking={isPicking('body')}
          onActivate={() => {
            if (isPicking('body')) setPendingPickField(null)
            else setPendingPickField({ featureId: fid, field: 'body', hostKind: 'transform' })
          }}
          onClear={() => onMutation({ type: 'set_transform_field', featureId: fid, field: 'body', value: '' })}
        />
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Operation</span>
        <select
          className="feature-field-select"
          value={transform.operation ?? 'new'}
          onChange={(e) => {
            e.stopPropagation()
            onMutation({ type: 'set_transform_field', featureId: fid, field: 'operation', value: e.target.value })
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="new">New</option>
          <option value="replace">Replace</option>
        </select>
      </div>

      <div className="feature-field-row">
        <span className="feature-field-label">Translation</span>
      </div>
      {numField('X', transform.translation?.[0], (v) => {
        const t = transform.translation ?? [0, 0, 0]
        onMutation({ type: 'set_transform_field', featureId: fid, field: 'translation', value: [v, t[1], t[2]] })
      })}
      {numField('Y', transform.translation?.[1], (v) => {
        const t = transform.translation ?? [0, 0, 0]
        onMutation({ type: 'set_transform_field', featureId: fid, field: 'translation', value: [t[0], v, t[2]] })
      })}
      {numField('Z', transform.translation?.[2], (v) => {
        const t = transform.translation ?? [0, 0, 0]
        onMutation({ type: 'set_transform_field', featureId: fid, field: 'translation', value: [t[0], t[1], v] })
      })}

      <div className="feature-field-row">
        <span className="feature-field-label">Rotation</span>
      </div>
      {numField('Angle (deg)', transform.rotation_angle, (v) => {
        onMutation({ type: 'set_transform_field', featureId: fid, field: 'rotation_angle', value: v })
      })}
      <div className="feature-field-row">
        <span className="feature-field-label">Axis</span>
        <PickChip
          value={transform.rotation_axis}
          isPicking={isPicking('rotation_axis')}
          onActivate={() => {
            if (isPicking('rotation_axis')) setPendingPickField(null)
            else setPendingPickField({ featureId: fid, field: 'rotation_axis', hostKind: 'transform' })
          }}
          onClear={() => onMutation({ type: 'set_transform_field', featureId: fid, field: 'rotation_axis', value: '' })}
        />
      </div>

      <div className="feature-field-row">
        <span className="feature-field-label">Scale</span>
      </div>
      {numField('Factor', transform.scale, (v) => {
        onMutation({ type: 'set_transform_field', featureId: fid, field: 'scale', value: v })
      })}
    </div>
  )
}
