import React from 'react'
import type { PartFeature, Mutation, PendingPickField } from '../types/cad'

interface HoleEditorProps {
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

export const HoleEditor: React.FC<HoleEditorProps> = ({ feature, onMutation, pendingPickField, setPendingPickField }) => {
  const hole = feature.hole ?? { sketch: '', diameter: 10, depth_mode: 'blind', depth: 20, direction: 'normal' }
  const fid = feature.id
  const isPickingSketch = pendingPickField?.featureId === fid && pendingPickField?.field === 'sketch'

  return (
    <div className="plane-editor">
      <div className="feature-field-row">
        <span className="feature-field-label">Sketch</span>
        <PickChip
          value={hole.sketch || undefined}
          isPicking={isPickingSketch}
          onActivate={() => {
            if (isPickingSketch) setPendingPickField(null)
            else setPendingPickField({ featureId: fid, field: 'sketch', hostKind: 'hole' })
          }}
          onClear={() => onMutation({ type: 'set_hole_sketch', featureId: fid, sketch: '' })}
        />
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Diameter</span>
        <input
          type="number"
          className="feature-field-input"
          defaultValue={hole.diameter}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            const v = parseFloat(e.target.value)
            if (!isNaN(v) && v > 0)
              onMutation({ type: 'set_hole_diameter', featureId: fid, diameter: v })
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
        />
        <span className="feature-field-unit">mm</span>
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Depth mode</span>
        <select
          className="feature-field-select"
          value={hole.depth_mode}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onMutation({ type: 'set_hole_depth_mode', featureId: fid, depthMode: e.target.value as 'blind' | 'through_all' })}
        >
          <option value="blind">Blind</option>
          <option value="through_all">Through All</option>
        </select>
      </div>
      {hole.depth_mode === 'blind' && (
        <div className="feature-field-row">
          <span className="feature-field-label">Depth</span>
          <input
            type="number"
            className="feature-field-input"
            defaultValue={hole.depth}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              const v = parseFloat(e.target.value)
              if (!isNaN(v) && v > 0)
                onMutation({ type: 'set_hole_depth', featureId: fid, depth: v })
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
          />
          <span className="feature-field-unit">mm</span>
        </div>
      )}
      <div className="feature-field-row">
        <span className="feature-field-label">Direction</span>
        <select
          className="feature-field-select"
          value={hole.direction}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onMutation({ type: 'set_hole_direction', featureId: fid, direction: e.target.value as 'normal' | 'reverse' })}
        >
          <option value="normal">Normal</option>
          <option value="reverse">Reverse</option>
        </select>
      </div>
    </div>
  )
}
