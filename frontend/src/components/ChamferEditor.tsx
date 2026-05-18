import { useState } from 'react'
import type { PartFeature, Mutation } from '@/types/cad'
import { PickChip } from '@/components/PickChip'
import { useFieldPicking } from '@/hooks/useFieldPicking'

interface ChamferEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
  features?: PartFeature[]
  partLabels?: Record<string, string>
}

export function ChamferEditor({ feature, onMutation, features, partLabels }: ChamferEditorProps) {
  const chamfer = feature.chamfer ?? { edges: [], distance: 1, kind: 'distance', angle: 45 }
  const fid = feature.id
  const [isPickingEdges, setIsPickingEdges] = useState(false)

  useFieldPicking(isPickingEdges, (selectionId) => {
    const edgeQuery = selectionId.startsWith('face:')
      ? selectionId.split(':').slice(2).join(':')
      : selectionId
    onMutation({ type: 'add_chamfer_edge', featureId: fid, edgeQuery })
  })

  return (
    <div className="plane-editor">
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Edges</span>
        <PickChip
          values={chamfer.edges}
          isPicking={isPickingEdges}
          onActivate={() => setIsPickingEdges(!isPickingEdges)}
          onRemove={(index) => onMutation({ type: 'remove_chamfer_edge', featureId: fid, index })}
          onReorder={(from, to) => onMutation({ type: 'reorder_pick_field', featureId: fid, field: 'edges', fromIndex: from, toIndex: to })}
          features={features}
          partLabels={partLabels}
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
            onMutation({ type: 'set_chamfer_field', featureId: fid, field: 'kind', value: e.target.value })
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
              onMutation({ type: 'set_chamfer_field', featureId: fid, field: 'distance', value: v })
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
                onMutation({ type: 'set_chamfer_field', featureId: fid, field: 'angle', value: v })
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
          />
        </div>
      )}
    </div>
  )
}
