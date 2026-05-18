import { useState } from 'react'
import type { PartFeature, Mutation } from '@/types/cad'
import { PickChip } from '@/components/PickChip'
import { useFieldPicking } from '@/hooks/useFieldPicking'
import { normalizeRevolveSketch } from '@/utils/yamlMutations'

interface RevolveEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
  features?: PartFeature[]
  partLabels?: Record<string, string>
}

function resolveRevolveMergeRef(id: string): string {
  let bodyRef = id
  if (id.startsWith('body:')) {
    bodyRef = '@' + id.slice(5)
  } else if (id.startsWith('?')) {
    bodyRef = '@body_' + id.slice(1).split('/')[0]
  } else if (id.startsWith('@') && id.includes('/')) {
    bodyRef = '@' + id.slice(1).split('/')[0]
  }
  if (bodyRef.startsWith('@') && !bodyRef.startsWith('@body_')) {
    bodyRef = '@body_' + bodyRef.slice(1)
  }
  return bodyRef
}

function resolveAxisQuery(selectionId: string): string {
  if (selectionId.startsWith('face:')) {
    return selectionId.split(':').slice(2).join(':')
  }
  if (selectionId.startsWith('entity:')) {
    return '@' + selectionId.split(':').slice(1).join('/')
  }
  if (selectionId.startsWith('edge:')) {
    return selectionId.split(':').slice(2).join(':')
  }
  return selectionId
}

export function RevolveEditor({
  feature, onMutation, features, partLabels,
}: RevolveEditorProps) {
  const revolve = feature.revolve ?? { sketch: [], angle: 360, axis_origin: [0, 0, 0], axis_direction: [0, 0, 1] }
  const fid = feature.id
  const [isPickingSketch, setIsPickingSketch] = useState(false)
  const [isPickingAxis, setIsPickingAxis] = useState(false)
  const [isPickingMergeTarget, setIsPickingMergeTarget] = useState(false)
  const profiles = normalizeRevolveSketch(revolve.sketch)
  const showMergeTarget = revolve.operation !== 'new'

  useFieldPicking(isPickingSketch, (selectionId) => {
    const sketchQuery = selectionId.startsWith('face:')
      ? selectionId.split(':').slice(2).join(':')
      : selectionId
    const mutationType = selectionId.startsWith('entity:') || selectionId.startsWith('face:') ? 'add_revolve_profile' : 'add_revolve_profile'
    onMutation({ type: mutationType, featureId: fid, sketchQuery })
  })

  useFieldPicking(isPickingMergeTarget, (selectionId) => {
    onMutation({ type: 'set_revolve_field', featureId: fid, field: 'merge_target', value: resolveRevolveMergeRef(selectionId) })
    setIsPickingMergeTarget(false)
  })

  useFieldPicking(isPickingAxis, (selectionId) => {
    onMutation({ type: 'set_revolve_field', featureId: fid, field: 'axis', value: resolveAxisQuery(selectionId) })
    setIsPickingAxis(false)
  })

  return (
    <div className="plane-editor">
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Profile</span>
        <PickChip
          values={profiles}
          isPicking={isPickingSketch}
          onActivate={() => setIsPickingSketch(!isPickingSketch)}
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
              onMutation({ type: 'set_revolve_field', featureId: fid, field: 'angle', value: v })
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
              type: 'set_revolve_field',
              featureId: fid,
              field: 'direction',
              value: e.target.value,
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
              type: 'set_revolve_field',
              featureId: fid,
              field: 'operation',
              value: e.target.value,
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
            onActivate={() => setIsPickingMergeTarget(!isPickingMergeTarget)}
            onRemove={() => onMutation({ type: 'set_revolve_field', featureId: fid, field: 'merge_target', value: undefined })}
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
          onActivate={() => setIsPickingAxis(!isPickingAxis)}
          onRemove={() => onMutation({ type: 'set_revolve_field', featureId: fid, field: 'axis', value: '' })}
          features={features}
          partLabels={partLabels}
        />
      </div>
    </div>
  )
}
