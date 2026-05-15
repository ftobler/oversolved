import React from 'react'
import type { PartFeature, Mutation, PendingPickField } from '@/types/cad'
import { PickChip } from '@/components/PickChip'
import { normalizeRevolveSketch } from '@/utils/yamlMutations'

interface RevolveEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
  pendingPickField: PendingPickField | null
  setPendingPickField: (field: PendingPickField | null) => void
  selectionQuery: string | null
  features?: PartFeature[]
  partLabels?: Record<string, string>
}

export const RevolveEditor: React.FC<RevolveEditorProps> = ({
  feature, onMutation, pendingPickField, setPendingPickField, selectionQuery, features, partLabels,
}) => {
  const revolve = feature.revolve ?? { sketch: [], angle: 360, axis_origin: [0, 0, 0], axis_direction: [0, 0, 1] }
  const fid = feature.id
  const isPickingSketch = pendingPickField?.featureId === fid && pendingPickField.field === 'sketch'
  const isPickingAxis = pendingPickField?.featureId === fid && pendingPickField.field === 'axis'
  const isPickingMergeTarget = pendingPickField?.featureId === fid && pendingPickField?.field === 'merge_target'
  const profiles = normalizeRevolveSketch(revolve.sketch)
  const showMergeTarget = revolve.operation !== 'new'

  return (
    <div className="plane-editor">
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Profile</span>
        <PickChip
          values={profiles}
          isPicking={isPickingSketch}
          onActivate={() => {
            if (isPickingSketch) setPendingPickField(null)
            else setPendingPickField({ featureId: fid, field: 'sketch', hostKind: 'revolve' })
          }}
          onRemove={(index) => onMutation({ type: 'remove_revolve_profile', featureId: fid, index })}
          features={features}
          partLabels={partLabels}
        />
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Angle</span>
        <input
          type="number"
          className="feature-field-input"
          defaultValue={revolve.angle ?? 360}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            const v = parseFloat(e.target.value)
            if (!isNaN(v) && v > 0)
              onMutation({ type: 'set_revolve_angle', featureId: fid, angle: v })
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
        />
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Direction</span>
        <select
          className="feature-field-select"
          aria-label="Direction"
          value={revolve.direction ?? 'normal'}
          onChange={(e) => {
            e.stopPropagation()
            onMutation({
              type: 'set_revolve_direction',
              featureId: fid,
              direction: e.target.value as 'normal' | 'reverse' | 'symmetric',
            })
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="normal">Normal</option>
          <option value="reverse">Reverse</option>
          <option value="symmetric">Symmetric</option>
        </select>
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Operation</span>
        <select
          className="feature-field-select"
          aria-label="Operation"
          value={revolve.operation ?? 'add'}
          onChange={(e) => {
            e.stopPropagation()
            onMutation({
              type: 'set_revolve_operation',
              featureId: fid,
              operation: e.target.value as 'add' | 'cut' | 'new',
            })
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="add">Add</option>
          <option value="cut">Cut</option>
          <option value="new">New</option>
        </select>
      </div>
      {showMergeTarget && (
        <div className="feature-field-row feature-field-row--stacked">
          <span className="feature-field-label">Merge Target</span>
          <PickChip
            values={revolve.merge_target ? [revolve.merge_target] : []}
            isPicking={isPickingMergeTarget}
            onActivate={() => {
              if (isPickingMergeTarget) setPendingPickField(null)
              else setPendingPickField({ featureId: fid, field: 'merge_target', hostKind: 'revolve' })
            }}
            onRemove={() => onMutation({ type: 'set_revolve_merge_target', featureId: fid })}
            emptyText="(all bodies)"
            features={features}
            partLabels={partLabels}
          />
        </div>
      )}
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Axis</span>
        <PickChip
          values={revolve.axis && revolve.axis !== 'None' ? [revolve.axis] : []}
          isPicking={isPickingAxis}
          onActivate={() => {
            if (isPickingAxis) {
              setPendingPickField(null)
            } else if (selectionQuery) {
              onMutation({ type: 'set_revolve_axis', featureId: fid, axis: selectionQuery })
            } else {
              setPendingPickField({ featureId: fid, field: 'axis' })
            }
          }}
          onRemove={() => onMutation({ type: 'set_revolve_axis', featureId: fid, axis: '' })}
          features={features}
          partLabels={partLabels}
        />
      </div>
    </div>
  )
}
