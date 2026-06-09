import type { PartFeature, CircularArrayFeatureDef, Mutation } from '@/types/cad'
import { PickChip } from '@/components/sketch/PickChip'
import { usePickField } from '@/hooks/useFieldPicking'
import { resolveAxisQuery } from '@/utils/query/resolveBodyPickRef'

interface CircularArrayEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
  features?: PartFeature[]
  partLabels?: Record<string, string>
}

function CircularArrayEditor({ feature, onMutation, features, partLabels }: CircularArrayEditorProps) {
  const ca = feature.circular_array as CircularArrayFeatureDef ?? {}
  const fid = feature.id
  const axisPick = usePickField(fid, 'axis', (selectionId) => {
    onMutation({ type: 'set_circular_array_field', featureId: fid, field: 'axis', value: resolveAxisQuery(selectionId) })
  })

  return (
    <div className="plane-editor">
      <div className="feature-field-row">
        <span className="feature-field-label">Operation</span>
        <select
          className="feature-field-select"
          aria-label="Operation"
          value={ca.operation ?? 'add'}
          onChange={(e) => {
            e.stopPropagation()
            onMutation({ type: 'set_circular_array_field', featureId: fid, field: 'operation', value: e.target.value })
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="add">Add</option>
          <option value="new">New</option>
        </select>
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Include src</span>
        <input
          type="checkbox"
          checked={ca.include_source ?? true}
          onChange={(e) => {
            e.stopPropagation()
            onMutation({ type: 'set_circular_array_field', featureId: fid, field: 'include_source', value: e.target.checked })
          }}
        />
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Count</span>
        <input
          type="number"
          className="feature-field-input"
          min="1"
          defaultValue={ca.count ?? 4}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            const v = parseInt(e.target.value)
            if (!isNaN(v) && v > 0)
              onMutation({ type: 'set_circular_array_field', featureId: fid, field: 'count', value: v })
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
        />
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Evenly spaced</span>
        <input
          type="checkbox"
          checked={ca.step_angle == null}
          onChange={(e) => {
            e.stopPropagation()
            onMutation({ type: 'set_circular_array_field', featureId: fid, field: 'step_angle', value: e.target.checked ? null : (360 / (ca.count ?? 4)) })
          }}
        />
      </div>
      {ca.step_angle != null && (
        <div className="feature-field-row">
          <span className="feature-field-label">Step angle</span>
          <input
            type="number"
            className="feature-field-input"
            defaultValue={ca.step_angle}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              const v = parseFloat(e.target.value)
              if (!isNaN(v))
                onMutation({ type: 'set_circular_array_field', featureId: fid, field: 'step_angle', value: v })
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
          />
        </div>
      )}
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Axis</span>
        <PickChip
          values={ca.axis && ca.axis !== 'None' ? [ca.axis] : []}
          isPicking={axisPick.isPicking}
          onActivate={axisPick.toggle}
          onRemove={() => onMutation({ type: 'set_circular_array_field', featureId: fid, field: 'axis', value: '' })}
          features={features}
          partLabels={partLabels}
        />
      </div>
    </div>
  )
}

export default CircularArrayEditor
