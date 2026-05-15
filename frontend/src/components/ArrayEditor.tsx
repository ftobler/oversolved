import React from 'react'
import type { PartFeature, ArrayFeatureDef, Mutation } from '@/types/cad'

interface ArrayEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
}

const ArrayEditor: React.FC<ArrayEditorProps> = ({ feature, onMutation }) => {
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
            onMutation({ type: 'set_array_mode', featureId: fid, mode: e.target.value as 'linear' | 'rectangular' | 'rotational' })
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="linear">Linear</option>
          <option value="rectangular">Rectangular</option>
          <option value="rotational">Circular</option>
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
            onMutation({ type: 'set_array_operation', featureId: fid, operation: e.target.value as 'add' | 'new' })
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
            onMutation({ type: 'set_array_include_source', featureId: fid, includeSource: e.target.checked })
          }}
        />
      </div>
      {mode !== 'rotational' && (
        <>
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
                  onMutation({ type: 'set_array_direction_x', featureId: fid, direction_x: parts as [number, number, number] })
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
                  onMutation({ type: 'set_array_count_x', featureId: fid, count: v })
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
                  onMutation({ type: 'set_array_pitch_x', featureId: fid, pitch: v })
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
            />
          </div>
        </>
      )}
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
                  onMutation({ type: 'set_array_direction_y', featureId: fid, direction_y: parts as [number, number, number] })
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
                  onMutation({ type: 'set_array_count_y', featureId: fid, count: v })
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
                  onMutation({ type: 'set_array_pitch_y', featureId: fid, pitch: v })
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
            />
          </div>
        </>
      )}
      {mode === 'rotational' && (
        <>
          <div className="feature-field-row">
            <span className="feature-field-label">Count</span>
            <input
              type="number"
              className="feature-field-input"
              min="1"
              defaultValue={array.count ?? 4}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                const v = parseInt(e.target.value)
                if (!isNaN(v) && v > 0)
                  onMutation({ type: 'set_array_count', featureId: fid, count: v })
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
            />
          </div>
          <div className="feature-field-row">
            <span className="feature-field-label">Evenly spaced</span>
            <input
              type="checkbox"
              checked={array.step_angle == null}
              onChange={(e) => {
                e.stopPropagation()
                onMutation({ type: 'set_array_step_angle', featureId: fid, stepAngle: e.target.checked ? null : 360 / (array.count ?? 4) })
              }}
            />
          </div>
          {array.step_angle != null && (
            <div className="feature-field-row">
              <span className="feature-field-label">Step angle</span>
              <input
                type="number"
                className="feature-field-input"
                defaultValue={array.step_angle}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  const v = parseFloat(e.target.value)
                  if (!isNaN(v))
                    onMutation({ type: 'set_array_step_angle', featureId: fid, stepAngle: v })
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
              />
            </div>
          )}
          <div className="feature-field-row">
            <span className="feature-field-label">Axis</span>
            <input
              type="text"
              className="feature-field-input"
              defaultValue={array.axis ?? ''}
              placeholder="@sk1/axisLine"
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                onMutation({ type: 'set_array_axis', featureId: fid, axis: e.target.value })
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