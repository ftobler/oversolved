import type { PartFeature, Mutation, PendingPickField } from '@/types/cad'
import { PickChip } from '@/components/PickChip'

interface ChamferEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
  pendingPickField: PendingPickField | null
  setPendingPickField: (field: PendingPickField | null) => void
  features?: PartFeature[]
  partLabels?: Record<string, string>
}

export function ChamferEditor({ feature, onMutation, pendingPickField, setPendingPickField, features, partLabels }: ChamferEditorProps) {
  const chamfer = feature.chamfer ?? { edges: [], distance: 1, kind: 'distance', angle: 45 }
  const fid = feature.id
  const isPickingEdges = pendingPickField?.featureId === fid && pendingPickField?.field === 'edges'

  return (
    <div className="plane-editor">
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Edges</span>
        <PickChip
          values={chamfer.edges}
          isPicking={isPickingEdges}
          onActivate={() => {
            if (isPickingEdges) setPendingPickField(null)
            else setPendingPickField({ featureId: fid, field: 'edges', hostKind: 'chamfer' })
          }}
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
