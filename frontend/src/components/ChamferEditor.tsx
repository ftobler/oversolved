import React from 'react'
import type { PartFeature, Mutation, PendingPickField } from '../types/cad'

interface ChamferEditorProps {
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

export const ChamferEditor: React.FC<ChamferEditorProps> = ({ feature, onMutation, pendingPickField, setPendingPickField }) => {
  const chamfer = feature.chamfer ?? { edges: [], distance: 1, kind: 'distance', angle: 45 }
  const fid = feature.id
  const isPickingEdges = pendingPickField?.featureId === fid && pendingPickField?.field === 'edges'

  return (
    <div className="plane-editor">
      <div className="feature-field-row">
        <span className="feature-field-label">Edges</span>
        <ListPickChip
          values={chamfer.edges}
          isPicking={isPickingEdges}
          onActivate={() => {
            if (isPickingEdges) setPendingPickField(null)
            else setPendingPickField({ featureId: fid, field: 'edges', hostKind: 'chamfer' })
          }}
          onRemove={(index) => onMutation({ type: 'remove_chamfer_edge', featureId: fid, index })}
        />
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Kind</span>
        <select
          className="feature-field-select"
          aria-label="Chamfer kind"
          value={chamfer.kind ?? 'distance'}
          onChange={(e) => {
            e.stopPropagation()
            onMutation({ type: 'set_chamfer_kind', featureId: fid, kind: e.target.value as 'distance' | 'angle_distance' })
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="distance">Distance</option>
          <option value="angle_distance">Angle + Distance</option>
        </select>
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Distance</span>
        <input
          type="number"
          className="feature-field-input"
          defaultValue={chamfer.distance}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            const v = parseFloat(e.target.value)
            if (!isNaN(v) && v > 0)
              onMutation({ type: 'set_chamfer_distance', featureId: fid, distance: v })
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
        />
      </div>
      {chamfer.kind === 'angle_distance' && (
        <div className="feature-field-row">
          <span className="feature-field-label">Angle</span>
          <input
            type="number"
            className="feature-field-input"
            defaultValue={chamfer.angle ?? 45}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              const v = parseFloat(e.target.value)
              if (!isNaN(v) && v > 0)
                onMutation({ type: 'set_chamfer_angle', featureId: fid, angle: v })
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
          />
        </div>
      )}
    </div>
  )
}
