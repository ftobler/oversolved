import { useState } from 'react'
import type { PartFeature, Mutation } from '@/types/cad'
import { PickChip } from '@/components/PickChip'
import { useFieldPicking } from '@/hooks/useFieldPicking'

interface FilletEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
  features?: PartFeature[]
  partLabels?: Record<string, string>
}

export function FilletEditor({ feature, onMutation, features, partLabels }: FilletEditorProps) {
  const fillet = feature.fillet ?? { edges: [], radius: 1 }
  const fid = feature.id
  const [isPickingEdges, setIsPickingEdges] = useState(false)

  useFieldPicking(isPickingEdges, (selectionId) => {
    const edgeQuery = selectionId.startsWith('face:')
      ? selectionId.split(':').slice(2).join(':')
      : selectionId
    onMutation({ type: 'add_fillet_edge', featureId: fid, edgeQuery })
  })

  return (
    <div className="plane-editor">
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Edges</span>
        <PickChip
          values={fillet.edges}
          isPicking={isPickingEdges}
          onActivate={() => setIsPickingEdges(!isPickingEdges)}
          onRemove={(index) => onMutation({ type: 'remove_fillet_edge', featureId: fid, index })}
          onReorder={(from, to) => onMutation({ type: 'reorder_pick_field', featureId: fid, field: 'edges', fromIndex: from, toIndex: to })}
          features={features}
          partLabels={partLabels}
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
              onMutation({ type: 'set_fillet_field', featureId: fid, field: 'radius', value: v })
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
        />
      </div>
    </div>
  )
}
