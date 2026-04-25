import React from 'react'
import type { PartFeature, Mutation, PendingPickField } from '../types/cad'

interface FilletEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
  pendingPickField: PendingPickField | null
  setPendingPickField: (field: PendingPickField | null) => void
}

const ListPickChip: React.FC<{ values: string[]; isPicking: boolean; onActivate: () => void; onRemove: (index: number) => void }> = ({ values, isPicking, onActivate, onRemove }) => {
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
            onClick={(e) => { e.stopPropagation(); onRemove(i) }}
            title="Remove"
          >×</button>
        </div>
      ))}
    </div>
  )
}

export const FilletEditor: React.FC<FilletEditorProps> = ({ feature, onMutation, pendingPickField, setPendingPickField }) => {
  const fillet = feature.fillet ?? { edges: [], radius: 1 }
  const fid = feature.id
  const isPickingEdges = pendingPickField?.featureId === fid && pendingPickField?.field === 'edges'

  return (
    <div className="plane-editor">
      <div className="feature-field-row">
        <span className="feature-field-label">Edges</span>
        <ListPickChip
          values={fillet.edges}
          isPicking={isPickingEdges}
          onActivate={() => {
            if (isPickingEdges) setPendingPickField(null)
            else setPendingPickField({ featureId: fid, field: 'edges', hostKind: 'fillet' })
          }}
          onRemove={(index) => onMutation({ type: 'remove_fillet_edge', featureId: fid, index })}
        />
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Radius</span>
        <input
          type="number"
          className="feature-field-input"
          defaultValue={fillet.radius}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            const v = parseFloat(e.target.value)
            if (!isNaN(v) && v > 0)
              onMutation({ type: 'set_fillet_radius', featureId: fid, radius: v })
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
        />
      </div>
    </div>
  )
}
