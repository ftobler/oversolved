import React from 'react'
import type { PartFeature, Mutation, PendingPickField } from '../types/cad'
import { PickChip } from './PickChip'

interface FilletEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
  pendingPickField: PendingPickField | null
  setPendingPickField: (field: PendingPickField | null) => void
}

export const FilletEditor: React.FC<FilletEditorProps> = ({ feature, onMutation, pendingPickField, setPendingPickField }) => {
  const fillet = feature.fillet ?? { edges: [], radius: 1 }
  const fid = feature.id
  const isPickingEdges = pendingPickField?.featureId === fid && pendingPickField?.field === 'edges'

  return (
    <div className="plane-editor">
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Edges</span>
        <PickChip
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
