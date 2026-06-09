import type { PartFeature, ArrayFeatureDef, Mutation } from '@/types/cad'

interface ArrayEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
  features?: PartFeature[]
  partLabels?: Record<string, string>
}

function ArrayEditor({ feature, onMutation }: ArrayEditorProps) {
  const array = feature.array as ArrayFeatureDef ?? {}
  const fid = feature.id
  const mode = array.mode ?? 'linear'

  return (
    <div className="plane-editor">
      <div className="feature-field-row">
        <span className="feature-field-label">Mode</span>
        <select
          className="feature-field-select"
          aria-label="Mode"
          value={mode}
          onChange={(e) => {
            e.stopPropagation()
            onMutation({ type: 'set_array_field', featureId: fid, field: 'mode', value: e.target.value })
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="linear">Linear</option>
          <option value="rectangular">Rectangular</option>
        </select>
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Operation</span>
        <select
          className="feature-field-select"
          aria-label="Operation"
          value={array.operation ?? 'add'}
          onChange={(e) => {
            e.stopPropagation()
            onMutation({ type: 'set_array_field', featureId: fid, field: 'operation', value: e.target.value })
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
          checked={array.include_source ?? true}
          onChange={(e) => {
            e.stopPropagation()
            onMutation({ type: 'set_array_field', featureId: fid, field: 'include_source', value: e.target.checked })
          }}
        />
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">
          Direction X
          <span className="feature-field-hint" title="unit direction vector (e.g. 1,0,0 = +X)">(i)</span>
        </span>
        <input
          type="text"
          className="feature-field-input"
          defaultValue={array.direction_x?.join(', ') ?? '1, 0, 0'}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            const parts = e.target.value.split(',').map(s => parseFloat(s.trim()))
            if (parts.length === 3 && parts.every(p => !isNaN(p))) {
              onMutation({ type: 'set_array_field', featureId: fid, field: 'direction_x', value: parts })
            }
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
        />
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Count X</span>
        <input
          type="number"
          className="feature-field-input"
          min="1"
          defaultValue={array.count_x ?? 2}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            const v = parseInt(e.target.value)
            if (!isNaN(v) && v > 0)
              onMutation({ type: 'set_array_field', featureId: fid, field: 'count_x', value: v })
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
        />
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Pitch X</span>
        <input
          type="number"
          className="feature-field-input"
          min="0"
          defaultValue={array.pitch_x ?? 20}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            const v = parseFloat(e.target.value)
            if (!isNaN(v) && v >= 0)
              onMutation({ type: 'set_array_field', featureId: fid, field: 'pitch_x', value: v })
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
        />
      </div>
      {mode === 'rectangular' && (
        <>
          <div className="feature-field-row">
            <span className="feature-field-label">Direction Y</span>
            <input
              type="text"
              className="feature-field-input"
              defaultValue={array.direction_y?.join(', ') ?? '0, 1, 0'}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                const parts = e.target.value.split(',').map(s => parseFloat(s.trim()))
                if (parts.length === 3 && parts.every(p => !isNaN(p))) {
                  onMutation({ type: 'set_array_field', featureId: fid, field: 'direction_y', value: parts })
                }
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
            />
          </div>
          <div className="feature-field-row">
            <span className="feature-field-label">Count Y</span>
            <input
              type="number"
              className="feature-field-input"
              min="1"
              defaultValue={array.count_y ?? 2}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                const v = parseInt(e.target.value)
                if (!isNaN(v) && v > 0)
                  onMutation({ type: 'set_array_field', featureId: fid, field: 'count_y', value: v })
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
            />
          </div>
          <div className="feature-field-row">
            <span className="feature-field-label">Pitch Y</span>
            <input
              type="number"
              className="feature-field-input"
              min="0"
              defaultValue={array.pitch_y ?? 20}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                const v = parseFloat(e.target.value)
                if (!isNaN(v) && v >= 0)
                  onMutation({ type: 'set_array_field', featureId: fid, field: 'pitch_y', value: v })
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
            />
          </div>
        </>
      )}
    </div>
  )
}

export default ArrayEditor